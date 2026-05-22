import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { ContextInjectionController } from '../context-injection.js'
import { SessionContext } from '../context.js'
import { PromptEngine } from '../../prompt/engine.js'
import { ContextClaimStore } from '../../context/claim-store.js'
import { READ_FILE_TOOL } from '../../tools/read-file.js'
import type { RepairHintTracker } from '../repair-hint.js'
import type { ToolHistoryEntry } from '../../prompt/volatile.js'

function makeEngine(): PromptEngine {
  return new PromptEngine({
    model: 'deepseek-v4-pro',
    maxTokens: 1024,
    staticCtx: { tools: [READ_FILE_TOOL.definition] },
    volatileCtx: { cwd: '/tmp/project' },
  })
}

function makeController(input: {
  session?: SessionContext
  engine?: PromptEngine
  claimStore?: ContextClaimStore
  repairHint?: string | null
  toolHistory?: ToolHistoryEntry[]
} = {}): ContextInjectionController {
  const session = input.session ?? new SessionContext()
  const engine = input.engine ?? makeEngine()
  const repairHintTracker: RepairHintTracker = { getHint: () => input.repairHint ?? null } as RepairHintTracker
  return new ContextInjectionController({
    session,
    promptEngine: engine,
    contextWindow: 1024,
    getSessionId: () => 'session-1',
    getTranscriptPath: () => '/tmp/transcript.jsonl',
    getSessionMemoryState: () => undefined,
    getMessages: () => session.getMessages(),
    getRecentToolHistory: () => input.toolHistory ?? [],
    getRepairHintTracker: () => repairHintTracker,
    getContextClaimStore: () => input.claimStore,
    getPlaybookStore: () => undefined,
  })
}

describe('ContextInjectionController', () => {
  it('refreshes ledger with user anchors', () => {
    const session = new SessionContext()
    session.addUserMessage('hello')
    const controller = makeController({ session })

    controller.addAnchor('user_constraint', 'Always run tests')

    const ledger = session.getContextLedger()
    assert.equal(ledger?.anchors.length, 1)
    assert.equal(ledger?.anchors[0]?.text, 'Always run tests')
  })

  it('projects active claims into prompt context and records prompt consumers', () => {
    const dir = mkdtempSync(join(tmpdir(), 'rivet-context-injection-'))
    try {
      const claimStore = new ContextClaimStore(dir, 'session-1')
      const engine = makeEngine()
      const controller = makeController({ claimStore, engine })
      const createdAt = Date.now()
      claimStore.propose({
        kind: 'user_constraint',
        scope: 'session',
        text: 'Always prefer targeted tests for changed files.',
        confidence: 0.9,
        fitness: 3,
        source: { actor: 'user', sessionId: 'session-1', turn: 0, eventId: 'turn-0:user-input' },
        evidence: [{ id: 'turn-0:user-input:anchor', kind: 'user_message', summary: 'Always prefer targeted tests for changed files.', createdAt }],
        createdAt,
        tags: ['anchor', 'user_constraint'],
      })

      controller.refreshActiveClaims()
      const request = engine.buildOaiRequest([{ role: 'user', content: 'next' }])
      const joined = request.messages.map(m => typeof m.content === 'string' ? m.content : '').join('\n')
      assert.doesNotMatch(joined, /<active-claims/)
      assert.ok(claimStore.listClaims().some(c => c.consumers.some(consumer => consumer.kind === 'prompt')))
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('projects repair hint through prompt engine (cerebellar hint is harness-only)', () => {
    const engine = makeEngine()
    const controller = makeController({ engine, repairHint: '<repair-hint tool="read_file">check path</repair-hint>' })

    controller.refreshRepairHint()
    controller.setCerebellarHint('hint')

    const request = engine.buildOaiRequest([{ role: 'user', content: 'next' }])
    const joined = request.messages.map(m => typeof m.content === 'string' ? m.content : '').join('\n')
    assert.match(joined, /&lt;repair-hint tool=&quot;read_file&quot;&gt;check path&lt;\/repair-hint&gt;/)
    assert.doesNotMatch(joined, /Prediction error rate elevated/)
  })
})
