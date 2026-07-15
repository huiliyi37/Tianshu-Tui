import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { CompactionController } from '../compaction-controller.js'
import { SessionContext } from '../context.js'
import { PromptEngine } from '../../prompt/engine.js'
import { PressureMonitor } from '../../context/pressure-monitor.js'
import type { TrajectoryEntry } from '../trajectory.js'
import type { OaiChatRequest } from '../../api/oai-types.js'
import type { StreamCallbacks, StreamClient } from '../../api/stream-client.js'
import { extractTaskContract } from '../../context/task-contract.js'

/**
 * W3-C1: tryPartialCompact state-coverage guard.
 *
 * llmCompact already rejects summaries that reflect NONE of the material
 * trajectory state (summaryCoversState, compaction-controller.ts:1344).
 * The partial path historically had no such check. Partial compact has two
 * deterministic backstops — the verbatim oldZone archive (recall ref) and the
 * task-anchor appendix — so the guard only rejects when the summary covers
 * nothing AND neither backstop is available (the summary would be the sole
 * carrier of the discarded history).
 */

function longHistory(): SessionContext {
  const session = new SessionContext()
  const msgs = Array.from({ length: 70 }, (_, i) => ({
    role: (i % 2 === 0 ? 'user' : 'assistant') as 'user' | 'assistant',
    content: 'x'.repeat(40_000),
  }))
  session.replaceMessages(msgs)
  return session
}

const FAILED_TRAJECTORY: TrajectoryEntry[] = [
  { turn: 1, tool: 'write_file', target: 'src/foo.ts', durationMs: 10, status: 'failed', errorClass: 'TS2322', inputSummary: 'edit', resultSummary: 'type error' },
]

function coveringNothingClient(): StreamClient {
  return {
    stream: async (_req: OaiChatRequest, cb: StreamCallbacks) => {
      cb.onTextDelta('We did some work and made progress on various things.')
    },
  }
}

function makeController(session: SessionContext, overrides: Partial<ConstructorParameters<typeof CompactionController>[0]> = {}): CompactionController {
  return new CompactionController({
    session,
    promptEngine: new PromptEngine({ model: 'test-model', maxTokens: 1024, staticCtx: { tools: [] }, volatileCtx: { cwd: '/test' } }),
    contextWindow: 1_000_000,
    pressureMonitor: new PressureMonitor(1_000_000),
    getTrajectoryEntries: () => FAILED_TRAJECTORY,
    getStreamedText: () => '',
    refreshLedger: () => {},
    ...overrides,
  })
}

describe('tryPartialCompact state-coverage guard (W3-C1)', () => {
  it('rejects a nothing-covering summary when there is no archive and no anchor backstop', async () => {
    const session = longHistory()
    const before = session.getMessages().length
    const controller = makeController(session, { primaryClient: coveringNothingClient() })

    const ok = await controller.tryPartialCompact(30)

    assert.equal(ok, false, 'partial compact must reject a summary that covers no material state when it would be the sole carrier')
    assert.equal(session.getMessages().length, before, 'history must stay untouched on rejection')
  })

  it('accepts a nothing-covering summary when the verbatim archive backstop exists', async () => {
    const session = longHistory()
    const controller = makeController(session, {
      primaryClient: coveringNothingClient(),
      archiveHistory: async () => 'session_history_1',
    })

    const ok = await controller.tryPartialCompact(30)

    assert.equal(ok, true, 'verbatim archive keeps the old zone recoverable — lossy summary tolerated')
    const summaryMsg = session.getMessages().find(m => String(m.content).includes('partial-compact-summary'))
    assert.ok(summaryMsg, 'summary message present')
    assert.match(String(summaryMsg!.content), /session_history_1/, 'recall ref embedded')
  })

  it('accepts a nothing-covering summary when the task-anchor backstop exists', async () => {
    const session = longHistory()
    const contract = extractTaskContract(
      'Refactor compaction-controller.ts. Constraint: do not break the prefix cache. Touch src/agent/compaction-controller.ts only.',
    )
    const controller = makeController(session, {
      primaryClient: coveringNothingClient(),
      getActiveContract: () => contract,
    })

    const ok = await controller.tryPartialCompact(30)

    assert.equal(ok, true, 'task-anchor carries scope/constraints deterministically — lossy summary tolerated')
  })

  it('accepts a covering summary without any backstop', async () => {
    const session = longHistory()
    const coveringClient: StreamClient = {
      stream: async (_req: OaiChatRequest, cb: StreamCallbacks) => {
        cb.onTextDelta('Fixed the TS2322 failure in src/foo.ts and verified the change.')
      },
    }
    const controller = makeController(session, { primaryClient: coveringClient })

    const ok = await controller.tryPartialCompact(30)

    assert.equal(ok, true, 'covering summary passes the same check llmCompact uses')
  })
})
