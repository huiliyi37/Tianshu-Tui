import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { EvidenceTracker } from '../evidence.js'

describe('EvidenceTracker per-file verification levels', () => {
  it('marks modified files as pending before verification', () => {
    const tracker = new EvidenceTracker()
    tracker.trackFileModified('src/agent/loop.ts')

    const summary = tracker.getVerificationSummary()
    assert.equal(summary.total, 1)
    assert.equal(summary.verified, 0)
    assert.deepEqual(summary.files, [{ path: 'src/agent/loop.ts', level: 'pending' }])
  })

  it('marks TypeScript files as typed after tsc passes', () => {
    const tracker = new EvidenceTracker()
    tracker.trackFileModified('src/agent/loop.ts')
    tracker.trackFileModified('README.md')
    tracker.trackVerification({
      command: 'npx tsc --noEmit',
      status: 'passed',
      scope: 'full',
      exitCode: 0,
      passed: 1,
      failed: 0,
      skipped: 0,
      durationMs: 100,
    })

    const summary = tracker.getVerificationSummary()
    assert.deepEqual(summary.files, [
      { path: 'README.md', level: 'pending' },
      { path: 'src/agent/loop.ts', level: 'typed' },
    ])
    assert.equal(summary.verified, 1)
  })

  it('marks targeted files as tested when matching test command passes', () => {
    const tracker = new EvidenceTracker()
    tracker.trackFileModified('src/prompt/mode.ts')
    tracker.trackFileModified('src/tui/status-bar.tsx')
    tracker.trackVerification({
      command: 'npx tsx --test src/prompt/__tests__/mode.test.ts',
      status: 'passed',
      scope: 'targeted',
      exitCode: 0,
      passed: 3,
      failed: 0,
      skipped: 0,
      durationMs: 100,
    })

    const summary = tracker.getVerificationSummary()
    assert.deepEqual(summary.files, [
      { path: 'src/prompt/mode.ts', level: 'tested' },
      { path: 'src/tui/status-bar.tsx', level: 'pending' },
    ])
  })
})
