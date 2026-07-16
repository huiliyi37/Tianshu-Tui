/**
 * Wave 3 — worker fact adapters against the REAL evidence gate.
 *
 * Dual-source wiring:
 *  - episode path: writeGate/falseGreen/repairCount facts from WorkerEpisode
 *    (coordinator.recordWorkerEpisode) — falseGreen → decision-gate,
 *    blocked (environment-neutral) → status, never escalation.
 *  - aggregation path: post-verifyWorkerEvidence results only. The adapter
 *    maps gated outcomes; it never re-derives evidence policy and never
 *    trusts worker text claims.
 */
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { verifyWorkerEvidence } from '../worker-evidence.js'
import { buildWorkerEpisode } from '../worker-episode.js'
import { createWriteWorkOrder, type WorkerResult } from '../work-order.js'
import { signalFromWorkerEpisode, signalsFromVerifiedResults } from '../control-plane-adapters.js'
import { routeFor } from '../control-plane.js'
import type { WorkerWriteGateReport } from '../worker-write-gate.js'

function baseResult(overrides: Partial<WorkerResult> = {}): WorkerResult {
  return {
    workOrderId: 'wo-1',
    status: 'passed',
    summary: 'implemented the change',
    findings: [],
    artifacts: [],
    changedFiles: ['src/a.ts'],
    risks: [],
    nextActions: [],
    evidenceStatus: 'unverified',
    ...overrides,
  }
}

function gateReport(
  outcome: WorkerWriteGateReport['outcome'],
  falseGreen = false,
  repairCount = 0,
): { report: WorkerWriteGateReport; repairCount: number } {
  return {
    report: { outcome, checks: [], evidence: [], falseGreen, declaredFalseGreen: false },
    repairCount,
  }
}

const order = createWriteWorkOrder({
  parentTurnId: 't1',
  objective: 'fix the thing',
  kind: 'patch_proposal',
  scope: { files: ['src/a.ts'] },
  profile: 'patcher',
})

describe('episode-path adapter (writeGate facts)', () => {
  it('falseGreen episode → decision-gate (blocking, requiresDecision)', () => {
    const episode = buildWorkerEpisode({
      order, result: baseResult(), sessionId: 's1', model: 'm', role: 'hands',
      writeGate: gateReport('failed', true),
    })
    const signal = signalFromWorkerEpisode(episode)
    assert.equal(routeFor(signal), 'decision-gate')
    assert.equal(signal.severity, 'blocking')
    assert.match(signal.summary, /false green/)
  })

  it('gate blocked episode → status, environment-neutral, no escalation', () => {
    const episode = buildWorkerEpisode({
      order, result: baseResult(), sessionId: 's1', model: 'm', role: 'hands',
      writeGate: gateReport('blocked'),
    })
    const signal = signalFromWorkerEpisode(episode)
    assert.equal(routeFor(signal), 'status')
    assert.equal(signal.requiresDecision, false)
    assert.match(signal.summary, /environment-neutral/)
  })

  it('gate passed episode → silent (ordinary verified result)', () => {
    const episode = buildWorkerEpisode({
      order, result: baseResult({ evidenceStatus: 'verified' }), sessionId: 's1', model: 'm', role: 'hands',
      writeGate: gateReport('passed'),
    })
    assert.equal(routeFor(signalFromWorkerEpisode(episode)), 'silent')
  })
})

describe('aggregation-path adapter (real verifyWorkerEvidence output)', () => {
  it('write claim without verified evidence → gate marks blocked → status route', () => {
    const gated = verifyWorkerEvidence(baseResult({ evidenceStatus: 'unverified' }), 'implementer')
    assert.equal(gated.status, 'blocked') // real gate fail-closed behavior
    const [signal] = signalsFromVerifiedResults([gated])
    assert.ok(signal)
    assert.equal(routeFor(signal), 'status')
  })

  it('patcher advisory profile: unverified write survives gate → decision-gate', () => {
    const gated = verifyWorkerEvidence(baseResult({ evidenceStatus: 'unverified' }), 'patcher')
    assert.equal(gated.status, 'passed') // advisory profile: not blocked
    assert.equal(gated.evidenceStatus, 'unverified')
    const [signal] = signalsFromVerifiedResults([gated])
    assert.ok(signal)
    assert.equal(routeFor(signal), 'decision-gate')
    assert.equal(signal.kind, 'verification')
    assert.match(signal.summary, /without transcript verification evidence/)
  })

  it('verified passed result with metadata → silent (no master interruption)', () => {
    const gated = verifyWorkerEvidence(baseResult({
      evidenceStatus: 'verified',
      verification: { command: 'npm test', status: 'passed', exitCode: 0, passed: 12, failed: 0, skipped: 0, scope: 'full', durationMs: 100 },
    }), 'implementer')
    assert.equal(gated.status, 'passed')
    const [signal] = signalsFromVerifiedResults([gated])
    assert.ok(signal)
    assert.equal(routeFor(signal), 'silent')
  })

  it('W4: blocked with failureReason=timeout → requiresDecision + resume hint in summary', () => {
    const blocked = baseResult({
      status: 'blocked',
      changedFiles: [],
      evidenceStatus: 'unverified',
      failureReason: 'timeout',
      summary: 'Worker aborted (budget timeout)',
    })
    const [signal] = signalsFromVerifiedResults([blocked])
    assert.ok(signal)
    assert.equal(signal.requiresDecision, true, 'cut-off work needs a primary decision (rebudget/resume)')
    assert.match(signal.summary, /timeout/)
    assert.match(signal.summary, /resume re-dispatch/)
  })

  it('W4: blocked with failureReason=json_parse → status-level, no decision gate', () => {
    const blocked = baseResult({
      status: 'blocked',
      changedFiles: [],
      evidenceStatus: 'unverified',
      failureReason: 'json_parse',
      summary: 'Failed to parse worker output',
    })
    const [signal] = signalsFromVerifiedResults([blocked])
    assert.ok(signal)
    assert.equal(signal.requiresDecision, false, 'protocol fault is repairable noise, not a decision point')
    assert.match(signal.summary, /json_parse/)
  })

  it('worker text claims (全绿) are NOT trusted — the gate downgraded result maps to gate outcome, not the claim', () => {
    const gated = verifyWorkerEvidence(
      baseResult({ evidenceStatus: 'verified', summary: '全部测试通过，全绿' }),
      'implementer',
      { text: '', thinking: '', toolUses: ['edit_file'], toolResults: [], errors: [], repairAttempts: 0, bashCommands: [], failedBashCommands: [] },
    )
    assert.equal(gated.evidenceStatus, 'unverified') // claim without proof → downgraded
    const [signal] = signalsFromVerifiedResults([gated])
    assert.ok(signal)
    // adapter reflects the GATED status; the claim never upgrades the route
    assert.equal(routeFor(signal), 'decision-gate')
  })
})
