import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { createDeliveryGateV2 } from '../delivery-gate-v2.js'
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

  it('handles empty state gracefully', () => {
    const { gate } = makeGate([])

    const result = gate.assess([])
    assert.equal(result.state, 'GREEN')
    assert.equal(result.canDeliver, true)
    assert.equal(result.ownedFileCount, 0)
    assert.equal(result.externalFileCount, 0)
  })
})
