import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { addVerificationRun, emptyVerificationState, summarizeVerification, buildFinalVerificationReport } from '../verification.js'

const baseRun = {
  command: 'npm test',
  status: 'passed' as const,
  scope: 'full' as const,
  exitCode: 0,
  passed: 10,
  failed: 0,
  skipped: 0,
  durationMs: 100,
}

describe('verification state', () => {
  it('summarizes missing tests', () => {
    assert.equal(summarizeVerification(emptyVerificationState()), 'Tests not run')
  })

  it('summarizes full passed tests', () => {
    const state = addVerificationRun(emptyVerificationState(), baseRun)
    assert.equal(summarizeVerification(state), 'full tests passed: 10 passed, 0 failed')
  })

  it('summarizes blocked tests', () => {
    const state = addVerificationRun(emptyVerificationState(), { ...baseRun, status: 'blocked', exitCode: -1 })
    assert.equal(summarizeVerification(state), 'Tests blocked: npm test')
  })
})

describe('final verification report', () => {
  it('marks modified files as not verified when tests did not run', () => {
    const report = buildFinalVerificationReport({
      modifiedFiles: ['src/a.ts'],
      verification: emptyVerificationState(),
    })
    assert.match(report, /Not verified:/)
    assert.match(report, /tests not run after modifications/)
  })

  it('does not claim full verification for targeted tests', () => {
    const state = addVerificationRun(emptyVerificationState(), { ...baseRun, scope: 'targeted', command: 'npx tsx --test src/a.test.ts' })
    const report = buildFinalVerificationReport({ modifiedFiles: ['src/a.ts'], verification: state })
    assert.match(report, /Verified:/)
    assert.match(report, /targeted tests passed/)
    assert.match(report, /Not verified:/)
    assert.match(report, /full suite not run/)
  })

  it('reports risks when tests fail', () => {
    const state = addVerificationRun(emptyVerificationState(), { ...baseRun, status: 'failed', failed: 2, exitCode: 1 })
    const report = buildFinalVerificationReport({ modifiedFiles: ['src/a.ts'], verification: state })
    assert.match(report, /Risks: tests are failing/)
  })

  it('shows clean verification for full passed tests', () => {
    const state = addVerificationRun(emptyVerificationState(), baseRun)
    const report = buildFinalVerificationReport({ modifiedFiles: ['src/a.ts'], verification: state })
    assert.match(report, /Verified: full tests passed/)
    assert.ok(!report.includes('Not verified'))
    assert.ok(!report.includes('Risks'))
  })
})
