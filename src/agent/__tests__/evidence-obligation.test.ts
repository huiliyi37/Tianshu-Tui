/**
 * Wave 1 波末门禁（evidence-driven-agent-reasoning-loop 计划）：
 * - blocked verification 不满足 RED
 * - 失败目标不匹配不满足 RED
 * - 同目标交叉验证关闭存在性义务
 * 外加 reducer 基础契约：稳定 ID、升级阶梯、final 判定、字节稳定投影、
 * EvidenceTracker 验证事件出口、evidence-gate 分类单一事实源。
 */

import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import type { VerificationMetadata } from '../../tools/types.js'
import {
  applyProbeEvent,
  applyVerificationEvent,
  blockObligation,
  createObligation,
  deriveObligationId,
  emptyObligationStore,
  escalateAction,
  evaluateFinalCandidate,
  hasRedEvidence,
  recordAttempt,
  renderObligationBlock,
  satisfyObligation,
  supersedeOpenObligations,
  upsertObligation,
  type ObligationStore,
} from '../evidence-obligation.js'
import { EvidenceTracker } from '../evidence.js'
import { classifyEvidenceTool } from '../evidence-gate.js'

function verification(over: Partial<VerificationMetadata>): VerificationMetadata {
  return {
    command: 'npx tsx --test src/agent/__tests__/loop.test.ts',
    status: 'passed',
    scope: 'targeted',
    exitCode: 0,
    passed: 1,
    failed: 0,
    skipped: 0,
    durationMs: 100,
    ...over,
  }
}

function storeWith(...obs: ReturnType<typeof createObligation>[]): ObligationStore {
  return { obligations: obs }
}

describe('obligation identity (stable, cache-safe)', () => {
  it('same fact → same id regardless of whitespace; different wording → different id', () => {
    const a = deriveObligationId('existence', 'loop.ts   exports   AgentLoop', ['src/agent/loop.ts'])
    const b = deriveObligationId('existence', ' loop.ts exports AgentLoop ', ['src/agent/loop.ts'])
    const c = deriveObligationId('existence', 'AgentLoop is exported from loop.ts', ['src/agent/loop.ts'])
    assert.equal(a, b, 'whitespace-normalized claims converge')
    assert.notEqual(a, c, 'different wording = different obligation (design intent)')
    assert.match(a, /^ob_[0-9a-f]{12}$/, 'no timestamp / random component')
  })

  it('target order and separators do not change the id', () => {
    const a = deriveObligationId('behavior', 'x', ['b.ts', 'a.ts'])
    const b = deriveObligationId('behavior', 'x', ['a.ts', 'b.ts', 'a.ts'])
    assert.equal(a, b)
  })

  it('upsert merges same fact without resetting progress, uplifts risk only', () => {
    let store = upsertObligation(emptyObligationStore(), { family: 'behavior', claim: 'cache resets on boundary', targets: ['src/cache/x.ts'], risk: 'medium' })
    store = recordAttempt(store, store.obligations[0]!.id, { evidenceRef: 'src/cache/x.ts:10' })
    store = upsertObligation(store, { family: 'behavior', claim: 'cache resets on boundary', targets: ['src/cache/x.ts'], risk: 'high' })
    assert.equal(store.obligations.length, 1, 'no duplicate obligation')
    assert.equal(store.obligations[0]!.attempts, 1, 'progress preserved')
    assert.equal(store.obligations[0]!.risk, 'high', 'risk uplifted')
    const again = upsertObligation(store, { family: 'behavior', claim: 'cache resets on boundary', targets: ['src/cache/x.ts'], risk: 'low' })
    assert.equal(again.obligations[0]!.risk, 'high', 'risk never downgrades')
  })
})

describe('escalation ladder (failure is not repeating the same action)', () => {
  it('repeated failure class escalates the required action', () => {
    const ob = createObligation({ family: 'behavior', claim: 'y', targets: ['a.ts'] })
    let store = storeWith(ob)
    store = recordAttempt(store, ob.id, { failureClass: 'test_failure' })
    assert.equal(store.obligations[0]!.requiredAction, 'read_source', 'first failure: no escalation yet')
    store = recordAttempt(store, ob.id, { failureClass: 'test_failure' })
    assert.equal(store.obligations[0]!.requiredAction, 'micro_probe', 'same class twice → escalate read→probe')
  })

  it('two attempts without new evidence escalate; fresh evidence does not', () => {
    const ob = createObligation({ family: 'regression', claim: 'z', targets: ['b.ts'] })
    let store = storeWith(ob)
    store = recordAttempt(store, ob.id, {})
    store = recordAttempt(store, ob.id, {})
    assert.equal(store.obligations[0]!.requiredAction, 'baseline_diff', 'read-only stall routes to baseline diff')

    const ob2 = createObligation({ family: 'existence', claim: 'w', targets: ['c.ts'] })
    let store2 = storeWith(ob2)
    store2 = recordAttempt(store2, ob2.id, { evidenceRef: 'c.ts:1' })
    store2 = recordAttempt(store2, ob2.id, { evidenceRef: 'c.ts:9' })
    assert.equal(store2.obligations[0]!.requiredAction, 'read_source', 'new evidence per attempt: no escalation')
  })

  it('terminal actions map to themselves', () => {
    assert.equal(escalateAction('environment', 'integration_environment'), 'integration_environment')
    assert.equal(escalateAction('delivery', 'targeted_verification'), 'targeted_verification')
  })
})

describe('RED semantics (Wave 1 hard gate cases)', () => {
  const bugfix = createObligation({
    family: 'bugfix',
    claim: 'salvage drops valid findings',
    targets: ['src/agent/work-order.ts'],
    risk: 'high',
  })

  it('blocked verification is an attempt, NOT RED', () => {
    let store = storeWith(bugfix)
    store = applyVerificationEvent(store, verification({
      status: 'blocked', exitCode: 1, command: 'npx tsx --test src/agent/__tests__/work-order.test.ts',
      blockedReason: 'invocation_failure',
    }))
    const ob = store.obligations[0]!
    assert.equal(ob.state, 'attempted', 'blocked → attempted, never satisfied')
    assert.equal(hasRedEvidence(ob), false, 'no RED credit from a run that never executed')
    assert.equal(ob.lastFailureClass, 'verification_blocked')
  })

  it('unrelated failure does NOT satisfy RED (target mismatch)', () => {
    let store = storeWith(bugfix)
    store = applyVerificationEvent(store, verification({
      status: 'failed', failed: 3, exitCode: 1,
      command: 'npx tsx --test src/tui/__tests__/input-line.test.ts',
      targetFiles: ['src/tui/engine/input-line.ts'],
    }))
    const ob = store.obligations[0]!
    assert.equal(hasRedEvidence(ob), false, 'foreign failure is not a reproduction of THIS defect')
    assert.equal(ob.state, 'open', 'unrelated verification does not even count as an attempt on this obligation')
  })

  it('target-matched failure records RED; subsequent matching pass turns GREEN → satisfied', () => {
    let store = storeWith(bugfix)
    store = applyVerificationEvent(store, verification({
      status: 'failed', failed: 1, exitCode: 1,
      command: 'npx tsx --test src/agent/__tests__/work-order.test.ts',
      targetFiles: ['src/agent/work-order.ts'],
    }))
    assert.equal(hasRedEvidence(store.obligations[0]!), true, 'RED recorded')
    assert.equal(store.obligations[0]!.state, 'attempted', 'RED alone does not close the obligation')

    store = applyVerificationEvent(store, verification({
      status: 'passed', passed: 5,
      command: 'npx tsx --test src/agent/__tests__/work-order.test.ts',
      targetFiles: ['src/agent/work-order.ts'],
    }))
    assert.equal(store.obligations[0]!.state, 'satisfied', 'GREEN after RED closes the bugfix obligation')
  })

  it('pass WITHOUT prior RED does not close a bugfix obligation', () => {
    let store = storeWith(bugfix)
    store = applyVerificationEvent(store, verification({
      status: 'passed', passed: 5,
      command: 'npx tsx --test src/agent/__tests__/work-order.test.ts',
      targetFiles: ['src/agent/work-order.ts'],
    }))
    assert.notEqual(store.obligations[0]!.state, 'satisfied', 'a passing test cannot prove the defect ever existed')
  })
})

describe('probe accounting (existence / cross-check / lossy)', () => {
  it('cross-tool probe on the same target closes an existence obligation at cross_check stage', () => {
    const ob = createObligation({
      family: 'existence', claim: 'no other caller of frobnicate', targets: ['src/agent/loop.ts'],
      requiredAction: 'cross_check', risk: 'high',
    })
    let store = storeWith(ob)
    store = applyProbeEvent(store, { tool: 'grep', target: 'src/agent/loop.ts' })
    assert.equal(store.obligations[0]!.state, 'attempted', 'first tool: recorded, not closed')
    store = applyProbeEvent(store, { tool: 'grep', target: 'src/agent/loop.ts' })
    assert.notEqual(store.obligations[0]!.state, 'satisfied', 'same tool again is not independent cross-validation')
    store = applyProbeEvent(store, { tool: 'read_file', target: 'src/agent/loop.ts' })
    assert.equal(store.obligations[0]!.state, 'satisfied', 'second DISTINCT tool on same target closes it')
  })

  it('lossy probe cannot close a negative-existence claim; it only builds escalation pressure', () => {
    const ob = createObligation({ family: 'existence', claim: 'symbol X does not exist', targets: ['src/'] })
    let store = storeWith(ob)
    store = applyProbeEvent(store, { tool: 'semantic_search', target: 'src/', lossy: true })
    assert.equal(store.obligations[0]!.state, 'attempted')
    store = applyProbeEvent(store, { tool: 'semantic_search', target: 'src/', lossy: true })
    assert.equal(store.obligations[0]!.requiredAction, 'cross_check', 'repeated lossy_probe escalates read→cross_check')
    assert.notEqual(store.obligations[0]!.state, 'satisfied')
  })

  it('clean read closes a read_source-stage existence obligation', () => {
    const ob = createObligation({ family: 'existence', claim: 'AgentLoop ctor takes deps', targets: ['src/agent/loop.ts'] })
    let store = storeWith(ob)
    store = applyProbeEvent(store, { tool: 'read_file', target: 'src/agent/loop.ts', evidenceRef: 'src/agent/loop.ts:413' })
    assert.equal(store.obligations[0]!.state, 'satisfied')
    assert.ok(store.obligations[0]!.evidenceRefs.includes('src/agent/loop.ts:413'))
  })
})

describe('delivery / blocked / supersede lifecycle', () => {
  it('full-scope pass closes delivery; blocked never does', () => {
    const delivery = createObligation({ family: 'delivery', claim: 'change verified before claiming done', risk: 'high' })
    let store = storeWith(delivery)
    store = applyVerificationEvent(store, verification({ status: 'blocked', command: 'npm test' }))
    assert.equal(store.obligations[0]!.state, 'attempted', 'blocked verification is not delivery proof')
    store = applyVerificationEvent(store, verification({ status: 'passed', scope: 'full', command: 'npm test' }))
    assert.equal(store.obligations[0]!.state, 'satisfied')
  })

  it('blocked obligation can still be satisfied later by real evidence', () => {
    const ob = createObligation({ family: 'environment', claim: 'staging returns 502', risk: 'high' })
    let store = storeWith(ob)
    store = blockObligation(store, ob.id, 'no_staging_access')
    assert.equal(store.obligations[0]!.state, 'blocked')
    store = satisfyObligation(store, ob.id, 'staging-log:502')
    assert.equal(store.obligations[0]!.state, 'satisfied', 'blocked is not a death sentence')
  })

  it('task boundary supersedes open/attempted/blocked but not satisfied history', () => {
    const a = createObligation({ family: 'behavior', claim: 'a' })
    const b = createObligation({ family: 'behavior', claim: 'b' })
    let store = storeWith(a, b)
    store = satisfyObligation(store, a.id, 'x:1')
    store = supersedeOpenObligations(store)
    assert.equal(store.obligations.find(o => o.id === a.id)!.state, 'satisfied')
    assert.equal(store.obligations.find(o => o.id === b.id)!.state, 'superseded')
  })
})

describe('final gate evaluation (high-risk only — low_risk_small_edit_never_gates_final)', () => {
  it('open high-risk obligation → continue_once with the shortest next action', () => {
    const ob = createObligation({ family: 'bugfix', claim: 'fix the crash', targets: ['a.ts'], risk: 'high' })
    const result = evaluateFinalCandidate(storeWith(ob))
    assert.equal(result.verdict, 'continue_once')
    assert.equal(result.nextAction?.action, 'red_reproduction')
    assert.equal(result.nextAction?.obligationId, ob.id)
  })

  it('low/medium obligations never gate natural-finish', () => {
    const low = createObligation({ family: 'existence', claim: 'x', risk: 'low' })
    const medium = createObligation({ family: 'behavior', claim: 'y', risk: 'medium' })
    const result = evaluateFinalCandidate(storeWith(low, medium))
    assert.equal(result.verdict, 'allow')
  })

  it('only blocked high-risk left → honest_blocked (finish allowed, disclosure required)', () => {
    const ob = createObligation({ family: 'environment', claim: 'needs prod logs', risk: 'high' })
    const store = blockObligation(storeWith(ob), ob.id, 'no_access')
    const result = evaluateFinalCandidate(store)
    assert.equal(result.verdict, 'honest_blocked')
    assert.equal(result.blockedDisclosures.length, 1)
  })

  it('satisfied and superseded obligations do not gate', () => {
    const ob = createObligation({ family: 'bugfix', claim: 'fixed', targets: ['a.ts'], risk: 'high' })
    const store = satisfyObligation(storeWith(ob), ob.id, 'green:test')
    assert.equal(evaluateFinalCandidate(store).verdict, 'allow')
  })
})

describe('cache-stable projection', () => {
  it('identical state renders byte-identical output; empty store renders empty string', () => {
    const ob = createObligation({ family: 'behavior', claim: 'boundary compaction preserves anchors', targets: ['src/compact/x.ts'], risk: 'high' })
    const store = recordAttempt(storeWith(ob), ob.id, { evidenceRef: 'src/compact/x.ts:5' })
    const first = renderObligationBlock(store)
    const second = renderObligationBlock({ obligations: [...store.obligations] })
    assert.equal(first, second, 'no timestamps / randomness / unordered sets')
    assert.match(first, /<evidence-obligation count="1">/)
    assert.match(first, /next=read_source/)
    assert.equal(renderObligationBlock(emptyObligationStore()), '')
  })

  it('satisfied obligations leave the projection (attention released)', () => {
    const ob = createObligation({ family: 'existence', claim: 'x', targets: ['a.ts'], risk: 'high' })
    const store = satisfyObligation(storeWith(ob), ob.id, 'a.ts:1')
    assert.equal(renderObligationBlock(store), '')
  })
})

describe('EvidenceTracker verification event outlet (Wave 1 wiring point)', () => {
  it('listener receives every trackVerification; obligation state independent of TDD counter reset', () => {
    const tracker = new EvidenceTracker()
    let store = storeWith(createObligation({
      family: 'bugfix', claim: 'fix parse', targets: ['src/agent/work-order.ts'], risk: 'high',
    }))
    tracker.setVerificationListener(meta => { store = applyVerificationEvent(store, meta) })

    tracker.trackFileModified('src/agent/work-order.ts')
    tracker.trackVerification(verification({
      status: 'blocked', command: 'npx tsx --test src/agent/__tests__/work-order.test.ts',
    }))
    assert.equal(tracker.getGateState().editsSinceLastTest, 0, 'TDD counter reset by ANY verification (unchanged behavior)')
    assert.equal(store.obligations[0]!.state, 'attempted', 'obligation NOT cleared by the same event')
    assert.equal(hasRedEvidence(store.obligations[0]!), false)
  })

  it('listener errors never break evidence tracking', () => {
    const tracker = new EvidenceTracker()
    tracker.setVerificationListener(() => { throw new Error('boom') })
    assert.doesNotThrow(() => tracker.trackVerification(verification({})))
    assert.equal(tracker.getState().verifications.length, 1)
  })
})

describe('classifyEvidenceTool (single classification source, evidence-gate migration)', () => {
  it('classifies probes, decisions, and neutral tools', () => {
    assert.equal(classifyEvidenceTool({ tool: 'read_file', target: 'a.ts' }), 'probe')
    assert.equal(classifyEvidenceTool({ tool: 'run_tests', target: 'a.test.ts' }), 'probe')
    assert.equal(classifyEvidenceTool({ tool: 'bash', command: 'npm run typecheck' }), 'probe')
    assert.equal(classifyEvidenceTool({ tool: 'edit_file', target: 'a.ts' }), 'decision')
    assert.equal(classifyEvidenceTool({ tool: 'bash', command: 'rm -rf dist' }), null)
    assert.equal(classifyEvidenceTool({ tool: 'todo_write' }), null)
  })
})
