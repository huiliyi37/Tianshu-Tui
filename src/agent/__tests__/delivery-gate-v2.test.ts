import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { createDeliveryGateV2, filterExternalNoise, isJunkExternalPath } from '../delivery-gate-v2.js'
import { createOwnershipLedger } from '../ownership-ledger.js'
import { createWorktreeBaseline, type BaselineSnapshot } from '../worktree-baseline.js'
import { createTaskLedger } from '../task-ledger.js'
import { createVerificationAttribution } from '../verification-attribution.js'
import type { VerificationMetadata } from '../../tools/types.js'

function makeGate(ownedFiles: string[], externalDirty: string[] = []) {
  const baseline = createWorktreeBaseline({
    branch: 'feat/b1',
    head: 'abc',
    preExistingDirty: externalDirty,
    preExistingUntracked: [],
    capturedAt: Date.now(),
  })
  const ledger = createTaskLedger({ taskId: 't1' })
  for (const f of ownedFiles) ledger.record({ type: 'file_write', path: f })
  const ownership = createOwnershipLedger({ baseline, taskLedger: ledger })
  ownership.autoOwnFromLedger()
  const attr = createVerificationAttribution({ ownership })
  return {
    gate: createDeliveryGateV2({ taskLedger: ledger, ownership, attribution: attr }),
    ledger,
    ownership,
  }
}

describe('delivery-gate-v2 — ownership-aware delivery gate with GREEN/YELLOW/RED', () => {
  it('returns GREEN when owned files are verified', () => {
    const { gate, ledger } = makeGate(['src/tools/git.ts'])
    ledger.record({ type: 'verification', command: 'npx tsx --test', status: 'passed' })

    const result = gate.assess([])
    assert.equal(result.state, 'GREEN')
    assert.equal(result.canDeliver, true)
    assert.equal(result.isBlocked, false)
  })

  it('returns GREEN when no files modified', () => {
    const { gate } = makeGate([])

    const result = gate.assess([])
    assert.equal(result.state, 'GREEN')
    assert.equal(result.canDeliver, true)
  })

  it('returns RED when owned files are unverified', () => {
    const { gate } = makeGate(['src/tools/git.ts'])

    const result = gate.assess([])
    assert.equal(result.state, 'RED')
    assert.equal(result.canDeliver, false)
    assert.equal(result.isBlocked, true)
  })

  it('returns RED when owned verification fails', () => {
    const { gate, ledger } = makeGate(['src/tools/git.ts'])
    ledger.record({ type: 'verification', command: 'npx tsx --test', status: 'failed' })

    const result = gate.assess([])
    assert.equal(result.state, 'RED')
    assert.equal(result.canDeliver, false)
    assert.ok(result.reason!.includes('failure'))
  })

  it('returns YELLOW when external verification is blocked but owned are verified', () => {
    const { gate, ledger } = makeGate(['src/tools/git.ts'])
    ledger.record({ type: 'verification', command: 'npx tsc --noEmit', status: 'passed' })

    const externalV: VerificationMetadata = {
      command: 'lint',
      status: 'blocked',
      scope: 'full',
      exitCode: 2,
      passed: 0,
      failed: 0,
      skipped: 0,
      durationMs: 50,
    }

    const result = gate.assess([externalV])
    assert.equal(result.state, 'YELLOW')
    assert.equal(result.canDeliver, true)
    assert.equal(result.isBlocked, false)
    assert.ok(result.reason!.includes('external'))
  })

  it('returns YELLOW when no owned files but external files exist', () => {
    const { gate } = makeGate([], ['src/external-dirty.ts'])
    // No owned files, but external files exist → we can deliver our (empty) work
    // but need to note the external dirty files

    const result = gate.assess([])
    // No owned changes → GREEN (nothing to verify)
    assert.equal(result.state, 'GREEN')
    // But external files are noted
    assert.ok(result.externalFileCount! > 0)
  })

  it('getReport returns structured report with all details', () => {
    const { gate, ledger } = makeGate(['src/tools/git.ts', 'src/tools/diff.ts'], ['src/external.ts'])
    ledger.record({ type: 'verification', command: 'npx tsc --noEmit', status: 'passed' })
    ledger.record({ type: 'verification', command: 'npx tsx --test', status: 'passed' })

    const report = gate.getReport([])
    assert.equal(report.state, 'GREEN')
    assert.equal(report.taskId, 't1')
    assert.equal(report.ownedFileCount, 2)
    assert.equal(report.externalFileCount, 1)
    assert.equal(report.verificationCount, 2)
    assert.equal(report.ownedFiles.length, 2)
    assert.deepEqual(report.externalFiles, ['src/external.ts'])
  })

  it('getReport includes RED state with blocking reason', () => {
    const { gate, ledger } = makeGate(['src/tools/git.ts'])
    ledger.record({ type: 'verification', command: 'npx tsx --test', status: 'failed' })

    const report = gate.getReport([])
    assert.equal(report.state, 'RED')
    assert.equal(report.canDeliver, false)
    assert.ok(report.blockingReason)
  })

  it('does not block on historical owned files when no current dirty files are passed', () => {
    const { gate } = makeGate(['src/tools/git.ts'])

    const result = gate.assess([], [])
    assert.equal(result.state, 'GREEN')
    assert.equal(result.canDeliver, true)
    assert.equal(result.isBlocked, false)
    assert.equal(result.ownedFileCount, 0)
  })

  it('blocks on current dirty owned files when unverified', () => {
    const { gate } = makeGate(['src/tools/git.ts'])

    const result = gate.assess([], ['src/tools/git.ts'])
    assert.equal(result.state, 'RED')
    assert.equal(result.canDeliver, false)
    assert.equal(result.isBlocked, true)
    assert.equal(result.ownedFileCount, 1)
  })

  it('excludes external dirty files from current owned gate', () => {
    const { gate } = makeGate(['src/tools/git.ts'], ['src/external-dirty.ts'])

    const result = gate.assess([], ['src/external-dirty.ts'])
    assert.equal(result.state, 'GREEN')
    assert.equal(result.canDeliver, true)
    assert.equal(result.ownedFileCount, 0)
    assert.equal(result.externalFileCount, 1)
  })

  it('returns YELLOW for full-scope failed verification without owned attribution', () => {
    const { gate } = makeGate(['src/tools/git.ts'])
    const fullFailure: VerificationMetadata = {
      command: 'npm test',
      status: 'failed',
      scope: 'full',
      exitCode: 1,
      passed: 100,
      failed: 1,
      skipped: 0,
      durationMs: 1000,
    }

    const result = gate.assess([fullFailure])
    assert.equal(result.state, 'YELLOW')
    assert.equal(result.canDeliver, true)
    assert.equal(result.isBlocked, false)
    assert.match(result.reason!, /unresolved full-suite failure/)
  })

  it('returns YELLOW for full-scope failed ledger verification without owned attribution', () => {
    const { gate, ledger } = makeGate(['src/tools/git.ts'])
    ledger.record({ type: 'verification', command: 'npm test', status: 'failed', meta: { scope: 'full' } })

    const result = gate.assess([])
    assert.equal(result.state, 'YELLOW')
    assert.equal(result.canDeliver, true)
    assert.equal(result.isBlocked, false)
    assert.match(result.reason!, /unresolved full-suite failure/)
  })

  it('keeps failed ledger verifications targeted by default for backward compatibility', () => {
    const { gate, ledger } = makeGate(['src/tools/git.ts'])
    ledger.record({ type: 'verification', command: 'run_tests src/tools/__tests__/git.test.ts', status: 'failed' })

    const result = gate.assess([])
    assert.equal(result.state, 'RED')
    assert.equal(result.canDeliver, false)
    assert.equal(result.isBlocked, true)
  })

  it('getReport separates current owned dirty files from historical owned files', () => {
    const { gate } = makeGate(['src/tools/git.ts', 'src/tools/diff.ts'])

    const report = gate.getReport([], ['src/tools/git.ts'])
    assert.equal(report.ownedFileCount, 1)
    assert.deepEqual(report.ownedFiles, ['src/tools/git.ts'])
    assert.deepEqual(report.historicalOwnedFiles, ['src/tools/diff.ts'])
  })

  it('equivalent success supersedes old run_tests invocation failure', () => {
    const { gate, ledger } = makeGate(['src/tools/git.ts'])
    ledger.record({
      type: 'verification',
      command: 'run_tests src/tools/__tests__/git.test.ts',
      status: 'failed',
      meta: { scope: 'targeted', exitCode: 1, passed: 0, failed: 0, skipped: 0 },
    })
    ledger.record({
      type: 'verification',
      command: "tsx --test 'src/tools/__tests__/git.test.ts'",
      status: 'passed',
      meta: { scope: 'targeted', exitCode: 0, passed: 5, failed: 0, skipped: 0 },
    })

    const result = gate.assess([], ['src/tools/git.ts'])
    assert.equal(result.state, 'GREEN')
    assert.equal(result.supersededFailures, 1)
    assert.equal(result.staleFailureCandidates, 1)
  })

  it('returns YELLOW for invocation failure with current owned dirty files', () => {
    const { gate, ledger } = makeGate(['src/tools/git.ts'])
    ledger.record({
      type: 'verification',
      command: 'run_tests src/tools/__tests__/git.test.ts',
      status: 'failed',
      meta: { scope: 'targeted', exitCode: 1, passed: 0, failed: 0, skipped: 0, recommendedCommand: 'tsx --test src/tools/__tests__/git.test.ts' },
    })

    const result = gate.assess([], ['src/tools/git.ts'])
    assert.equal(result.state, 'YELLOW')
    assert.equal(result.isBlocked, false)
    assert.ok(result.reason?.includes('tool invocation'))
    assert.deepEqual(result.toolInvocationFailureCandidates, ['run_tests src/tools/__tests__/git.test.ts'])
    assert.equal(result.shortestNextStep, 'tsx --test src/tools/__tests__/git.test.ts')
  })

  it('keeps invocation failure as low-strength diagnostic when no current owned dirty files', () => {
    const { gate, ledger } = makeGate(['src/tools/git.ts'])
    ledger.record({
      type: 'verification',
      command: 'run_tests src/tools/__tests__/git.test.ts',
      status: 'failed',
      meta: { scope: 'targeted', exitCode: 1, passed: 0, failed: 0, skipped: 0 },
    })

    const result = gate.assess([], [])
    assert.equal(result.state, 'GREEN')
    assert.equal(result.ownedFileCount, 0)
    assert.equal(result.isBlocked, false)
    assert.deepEqual(result.toolInvocationFailureCandidates, ['run_tests src/tools/__tests__/git.test.ts'])
  })
})

describe('external-file noise filtering (C-fix, session 803d897d)', () => {
  it('classifies junk directory paths', () => {
    assert.equal(isJunkExternalPath('.test-tmp/x.json'), true)
    assert.equal(isJunkExternalPath('.rivet/external/y.md'), true)
    assert.equal(isJunkExternalPath('node_modules/pkg/index.js'), true)
    assert.equal(isJunkExternalPath('src/agent/loop.ts'), false)
    assert.equal(isJunkExternalPath('docs/notes.md'), false)
  })

  it('splits signal from noise and counts filtered paths', () => {
    const files = [
      '.test-tmp/a.json',
      '.test-tmp/b.json',
      'src/real.ts',
      '.rivet/external/c.md',
      'docs/keep.md',
    ]
    const split = filterExternalNoise(files)
    assert.deepEqual(split.files, ['src/real.ts', 'docs/keep.md'])
    assert.equal(split.noiseCount, 3)
  })

  it('returns all files when nothing is junk', () => {
    const split = filterExternalNoise(['src/a.ts', 'src/b.ts'])
    assert.deepEqual(split.files, ['src/a.ts', 'src/b.ts'])
    assert.equal(split.noiseCount, 0)
  })

  it('fails open when cwd is not a git repo', () => {
    const split = filterExternalNoise(['src/a.ts'], '/nonexistent-dir-for-test')
    assert.deepEqual(split.files, ['src/a.ts'])
    assert.equal(split.noiseCount, 0)
  })
})
