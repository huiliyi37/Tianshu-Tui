import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { ContextInjectionController } from '../context-injection.js'
import { AdvisoryBus } from '../advisory-bus.js'
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
  advisoryBus?: AdvisoryBus
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
    advisoryBus: input.advisoryBus,
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
      // Claims are no longer falsely marked as consumed by prompt on refresh
      assert.ok(claimStore.listClaims().every(c => c.consumers.length === 0))
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('routes repair hint through A1 advisory bus (legacy <repair-hint> block removed)', () => {
    const bus = new AdvisoryBus()
    const engine = makeEngine()
    const controller = makeController({ engine, repairHint: 'check path', advisoryBus: bus })

    controller.refreshRepairHint()
    controller.setCerebellarHint('hint')

    // A1: repair hint should go to bus, not to prompt engine's legacy block
    const request = engine.buildOaiRequest([{ role: 'user', content: 'next' }])
    const joined = request.messages.map(m => typeof m.content === 'string' ? m.content : '').join('\n')
    // Legacy <repair-hint> block should NOT appear
    assert.doesNotMatch(joined, /<repair-hint/)
    // Cerebellar hint should NOT appear as raw text in context
    assert.doesNotMatch(joined, /Prediction error rate elevated/)

    // Bus should contain both entries
    const rendered = bus.render()
    assert.match(rendered, /check path/)
    assert.match(rendered, /Prediction error rate elevated/)
    assert.match(rendered, /<星域-advisory>/)
  })
})
