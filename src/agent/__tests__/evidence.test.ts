import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { EvidenceTracker } from '../evidence.js'

describe('EvidenceTracker delivery status', () => {
  it('reports failed verification in the summary', () => {
    const tracker = new EvidenceTracker()
    tracker.trackFileModified('src/agent/loop.ts')
    tracker.trackVerification({
      command: 'npm test -- src/agent/__tests__/loop.test.ts',
      status: 'failed',
      scope: 'targeted',
      exitCode: 1,
      passed: 0,
      failed: 1,
      skipped: 0,
      durationMs: 500,
    })

    const summary = tracker.buildSummary()
    assert.equal(summary.verificationStatus, 'failed')
    assert.match(summary.verifications[0]!.command, /loop\.test\.ts/)
    assert.equal(tracker.getState().deliveryStatus, 'failed')
  })

  it('reports unverified edits when files changed without verification', () => {
    const tracker = new EvidenceTracker()
    tracker.trackFileModified('src/tools/web-fetch.ts')

    const summary = tracker.buildSummary()
    assert.equal(summary.verificationStatus, 'unverified')
    assert.deepEqual(summary.filesModified, ['src/tools/web-fetch.ts'])
    assert.equal(tracker.getState().deliveryStatus, 'unverified')
  })

  it('reports verified when tests pass', () => {
    const tracker = new EvidenceTracker()
    tracker.trackFileModified('src/a.ts')
    tracker.trackVerification({
      command: 'npm test',
      status: 'passed',
      scope: 'full',
      exitCode: 0,
      passed: 10,
      failed: 0,
      skipped: 0,
      durationMs: 1000,
    })

    assert.equal(tracker.getState().deliveryStatus, 'verified')
  })

  it('reports blocked when tests are blocked', () => {
    const tracker = new EvidenceTracker()
    tracker.trackFileModified('src/a.ts')
    tracker.trackVerification({
      command: 'npm test',
      status: 'blocked',
      scope: 'full',
      exitCode: 0,
      passed: 0,
      failed: 0,
      skipped: 0,
      durationMs: 0,
    })

    assert.equal(tracker.buildSummary().verificationStatus, 'blocked')
    assert.equal(tracker.getState().deliveryStatus, 'blocked')
  })

  it('failed takes priority over passed', () => {
    const tracker = new EvidenceTracker()
    tracker.trackFileModified('src/a.ts')
    tracker.trackVerification({ command: 'npm test -- a', status: 'passed', scope: 'targeted', exitCode: 0, passed: 5, failed: 0, skipped: 0, durationMs: 200 })
    tracker.trackVerification({ command: 'npm test -- b', status: 'failed', scope: 'targeted', exitCode: 1, passed: 0, failed: 1, skipped: 0, durationMs: 300 })

    assert.equal(tracker.getState().deliveryStatus, 'failed')
  })

  it('reset clears delivery status', () => {
    const tracker = new EvidenceTracker()
    tracker.trackFileModified('src/a.ts')
    tracker.trackVerification({ command: 'npm test', status: 'failed', scope: 'full', exitCode: 1, passed: 0, failed: 1, skipped: 0, durationMs: 100 })
    tracker.reset()
    assert.equal(tracker.getState().deliveryStatus, 'unverified')
    assert.equal(tracker.getState().verifications.length, 0)
  })

  // ── TDD gate: non-code files don't increment the edit counter ──

  it('does not increment editsSinceLastTest for non-code files', () => {
    const tracker = new EvidenceTracker()
    tracker.trackFileModified('docs/design/some-plan.md')
    tracker.trackFileModified('README.md')
    tracker.trackFileModified('.rivet/config.json')

    const gate = tracker.getGateState()
    assert.equal(gate.editsSinceLastTest, 0)
    assert.equal(gate.hasCodeEdits, false)
    assert.equal(gate.filesModified, 3) // filesModified still counts all
  })

  it('increments editsSinceLastTest for code files', () => {
    const tracker = new EvidenceTracker()
    tracker.trackFileModified('src/agent/loop.ts')
    tracker.trackFileModified('src/config/paths.ts')

    const gate = tracker.getGateState()
    assert.equal(gate.editsSinceLastTest, 2)
    assert.equal(gate.hasCodeEdits, true)
  })

  it('tracks hasCodeEdits correctly for mixed file types', () => {
    const tracker = new EvidenceTracker()
    tracker.trackFileModified('docs/design/plan.md')
    tracker.trackFileModified('src/agent/tdd-gate.ts')

    const gate = tracker.getGateState()
    assert.equal(gate.hasCodeEdits, true)
    assert.equal(gate.editsSinceLastTest, 1) // only the .ts file counts
  })

  it('resets hasCodeEdits and editsSinceLastTest on reset()', () => {
    const tracker = new EvidenceTracker()
    tracker.trackFileModified('src/a.ts')
    tracker.trackFileModified('src/b.ts')
    tracker.reset()

    const gate = tracker.getGateState()
    assert.equal(gate.editsSinceLastTest, 0)
    assert.equal(gate.hasCodeEdits, false)
  })

  it('buildSummary returns structured evidence snapshot', () => {
    const tracker = new EvidenceTracker()
    tracker.trackFileRead('src/a.ts')
    tracker.trackFileModified('src/b.ts')
    tracker.trackVerification({ command: 'npm test', status: 'passed', scope: 'full', exitCode: 0, passed: 3, failed: 0, skipped: 0, durationMs: 100 })

    const summary = tracker.buildSummary()
    assert.deepEqual(summary.filesRead, ['src/a.ts'])
    assert.deepEqual(summary.filesModified, ['src/b.ts'])
    assert.equal(summary.verificationStatus, 'verified')
    assert.equal(summary.verifications.length, 1)
    assert.equal(summary.gate.state, 'ok')
  })
})
