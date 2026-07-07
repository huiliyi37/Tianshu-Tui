import { describe, it, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import {
  CompactionController,
  foldAgedRecallBlocks,
  RECALL_KEEP_RECENT,
} from '../compaction-controller.js'
import { serializeMessagesForArchive } from '../compact-archive.js'
import { SessionContext } from '../context.js'
import { PromptEngine } from '../../prompt/engine.js'
import { PressureMonitor } from '../../context/pressure-monitor.js'
import { CacheAdvisor } from '../../cache/advisor.js'
import { READ_SECTION_TOOL } from '../../tools/read-section.js'
import { ArtifactStore } from '../../artifact/store.js'
import { COMPACT_HISTORY_TOOL, buildRecallMarker, parseRecallMarker } from '../../compact/recall-marker.js'
import type { OaiChatRequest } from '../../api/oai-types.js'
import type { StreamCallbacks, StreamClient } from '../../api/stream-client.js'

/**
 * End-to-end guard for the layered archival + recall loop. The controller's own
 * tests stub `archiveHistory` with an in-memory recorder; this crosses the real
 * boundaries the model actually traverses on a long thread:
 *
 *   compaction archives the old zone  →  ArtifactStore persists it to disk
 *     →  the REAL read_section tool recalls a verbatim slice (with marker)
 *       →  the next compaction collapses the recalled block back to a pointer.
 *
 * If any link silently breaks (catalog line ranges drift from the serialized
 * blob, the 2MB gate rejects a compact-history recall, the recall marker stops
 * round-tripping, eviction stops firing), one of the assertions below fails.
 */

function makeEngine(): PromptEngine {
  return new PromptEngine({
    model: 'test-model',
    maxTokens: 1024,
    staticCtx: { tools: [] },
    volatileCtx: { cwd: '/test' },
  })
}

function make1MSession(count = 70): SessionContext {
  const session = new SessionContext()
  const chunk = 'x'.repeat(40_000)
  const msgs = Array.from({ length: count }, (_, i) => ({
    role: (i % 2 === 0 ? 'user' : 'assistant') as 'user' | 'assistant',
    content: chunk,
  }))
  session.replaceMessages(msgs)
  return session
}

function summarizingClient(text = 'partial summary'): StreamClient {
  return {
    stream: async (_request: OaiChatRequest, callbacks: StreamCallbacks) => {
      callbacks.onTextDelta(text)
    },
  }
}

describe('compact ↔ recall round-trip (real ArtifactStore + read_section)', () => {
  let tempDir: string

  beforeEach(() => {
    // Project-local temp dir: os.tmpdir() is EPERM-restricted in the sandbox.
    const base = join(process.cwd(), '.rivet', 'tmp')
    mkdirSync(base, { recursive: true })
    tempDir = mkdtempSync(join(base, 'recall-roundtrip-'))
  })

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true })
  })

  it('archives on compaction, recalls verbatim via read_section, then evicts the recall to a pointer', async () => {
    const session = make1MSession()
    const store = new ArtifactStore(tempDir, 'roundtrip-session')
    const advisor = new CacheAdvisor({ providerProfile: { cacheType: 'exact-prefix', persistent: true } })

    const controller = new CompactionController({
      session,
      promptEngine: makeEngine(),
      contextWindow: 1_000_000,
      pressureMonitor: new PressureMonitor(1_000_000),
      getTrajectoryEntries: () => [],
      getStreamedText: () => '',
      refreshLedger: () => {},
      primaryClient: summarizingClient(),
      cacheAdvisor: advisor,
      // Real persistence: write the discarded zone to the on-disk store.
      archiveHistory: async (input) =>
        store.save({
          tool: COMPACT_HISTORY_TOOL,
          target: input.target,
          rawContent: input.rawContent,
          summary: input.summary,
          sections: input.sections,
        }),
      onArchive: (id, turn) => advisor.registerArchive(id, turn),
    })

    // ── 1. Compaction archives the dropped zone to the real store ──
    const result = await controller.maybeCompact({ loopTurn: 0, failures: { consecutiveFailures: 0 } })
    assert.equal(result.compacted, true, 'partial compaction should run on a 1M session at ~70%')

    const archives = store.list().filter(a => a.tool === COMPACT_HISTORY_TOOL)
    assert.equal(archives.length, 1, 'exactly one compact-history artifact persisted')
    const artifactId = archives[0]!.id

    // ── 2. The summary message carries the recall reference + turn→line catalog ──
    const summaryMsg = session.getMessages().find(m => String(m.content).includes('partial-compact-summary'))
    assert.ok(summaryMsg, 'partial-compact-summary message must exist')
    const summaryText = String(summaryMsg!.content)
    assert.match(summaryText, new RegExp(`artifact:${artifactId.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`))
    assert.match(summaryText, /read_section/)
    const rangeMatch = summaryText.match(/L(\d+)-L(\d+)/)
    assert.ok(rangeMatch, 'catalog must expose at least one L<start>-L<end> range')
    const section = rangeMatch![0]

    // ── 3. The REAL read_section tool recalls the verbatim slice (with marker) ──
    const recall = await READ_SECTION_TOOL.execute({
      input: { artifactId, section },
      toolUseId: 't-recall',
      cwd: tempDir,
      artifactStore: store,
      contextWindow: 1_000_000,
    })
    assert.equal(recall.isError, undefined, 'recall must succeed via the compact-history readLineRange fast path')
    const recalled = parseRecallMarker(recall.content)
    assert.ok(recalled, 'recalled content must start with a [recalled ...] marker')
    assert.equal(recalled!.artifactId, artifactId)
    assert.match(recall.content, /xxxxx/, 'recalled body must contain the verbatim archived chars')
    assert.match(recall.content, /--- turn:\d+ role:(user|assistant) ---/, 'recalled body preserves the archive dividers')

    // ── 4. Recall observability records the access (turn distance from archive) ──
    advisor.onTurnEnd({
      turn: 5,
      cacheRead: 100,
      cacheCreation: 0,
      prefixChanged: false,
      artifactIdsEvicted: [],
      artifactIdsAccessed: [artifactId],
    })
    const recallSummary = advisor.getRecallSummary()
    assert.equal(recallSummary.totalRecalls, 1, 'a compact-history access is recorded as a recall')
    assert.equal(recallSummary.uniqueArtifacts, 1)

    // ── 5. Re-compaction evicts the recalled block back to a one-line pointer ──
    // 5a. The serializer (used by the next compaction's archive step) collapses
    //     a recalled tool message instead of re-archiving its verbatim bytes.
    const recalledToolMsg = { role: 'tool' as const, tool_call_id: 't-recall', content: recall.content }
    const reArchived = serializeMessagesForArchive([recalledToolMsg])
    assert.match(
      reArchived.rawContent,
      new RegExp(`\\[recalled → ${artifactId.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')} ${section} \\(see original artifact\\)\\]`),
      'a recalled block must serialize to a pointer, not re-archived verbatim',
    )
    assert.doesNotMatch(reArchived.rawContent, /xxxxx/, 'the verbatim recalled bytes must not be duplicated into the new archive')

    // 5b. foldAgedRecallBlocks (the recent-zone A3 path) collapses aged recalls
    //     while keeping the most recent K, and is idempotent.
    const recalls = Array.from({ length: RECALL_KEEP_RECENT + 3 }, (_, i) => ({
      role: 'tool' as const,
      tool_call_id: `r${i}`,
      content: `${buildRecallMarker(artifactId, `L${i + 1}-L${i + 10}`)}\nverbatim body ${i}`,
    }))
    const folded = foldAgedRecallBlocks(recalls, RECALL_KEEP_RECENT)
    const foldedCount = folded.filter(m => /verbatim body/.test(String(m.content))).length
    assert.equal(foldedCount, RECALL_KEEP_RECENT, 'only the most recent K recalls keep their verbatim bodies')
    assert.deepEqual(foldAgedRecallBlocks(folded, RECALL_KEEP_RECENT), folded, 'fold is idempotent')
  })
})
