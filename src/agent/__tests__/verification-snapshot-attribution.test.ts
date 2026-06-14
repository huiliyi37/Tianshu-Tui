/**
 * VSW P2: snapshotRef staleness + integration_conflict attribution.
 */

import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { getEffectiveVerifications, createVerificationAttribution } from '../verification-attribution.js'
import type { TaskLedgerEvent } from '../task-ledger.js'
import type { VerificationMetadata } from '../../tools/types.js'
import type { OwnershipLedger } from '../ownership-ledger.js'

function makeVerificationEvent(
  command: string,
  status: 'passed' | 'failed' | 'blocked',
  scope: 'full' | 'targeted',
  timestamp: number,
  metaOverrides: Record<string, unknown> = {},
): TaskLedgerEvent {
  return { type: 'verification', timestamp, command, status, meta: { scope, ...metaOverrides } }
}

const stubOwnership = {} as OwnershipLedger

describe('getEffectiveVerifications — VSW snapshotRef staleness', () => {
  it('keeps all events when no currentSnapshotRef supplied (legacy behavior)', () => {
    const events = [
      makeVerificationEvent('run_tests a', 'passed', 'targeted', 1000, { snapshotRef: 'old', targetFiles: ['a.test.ts'] }),
    ]
    const result = getEffectiveVerifications(events)
    assert.equal(result.effective.length, 1)
    assert.equal(result.staleSnapshotDropped, 0)
  })

  it('drops verifications whose snapshotRef differs from the current ref', () => {
    const events = [
      makeVerificationEvent('run_tests a', 'passed', 'targeted', 1000, { snapshotRef: 'stale-ref', targetFiles: ['a.test.ts'] }),
    ]
    const result = getEffectiveVerifications(events, 'current-ref')
    assert.equal(result.effective.length, 0)
    assert.equal(result.staleSnapshotDropped, 1)
    assert.equal(result.totalRawCount, 1)
  })

  it('keeps verifications whose snapshotRef matches the current ref', () => {
    const events = [
      makeVerificationEvent('run_tests a', 'passed', 'targeted', 1000, { snapshotRef: 'current-ref', targetFiles: ['a.test.ts'] }),
    ]
    const result = getEffectiveVerifications(events, 'current-ref')
    assert.equal(result.effective.length, 1)
    assert.equal(result.staleSnapshotDropped, 0)
    assert.equal(result.effective[0]!.snapshotRef, 'current-ref')
  })

  it('never drops in-place verifications that lack a snapshotRef', () => {
    const events = [
      makeVerificationEvent('npx tsc --noEmit', 'passed', 'full', 1000),
    ]
    const result = getEffectiveVerifications(events, 'current-ref')
    assert.equal(result.effective.length, 1)
    assert.equal(result.staleSnapshotDropped, 0)
  })

  it('propagates verificationPhase into effective metadata', () => {
    const events = [
      makeVerificationEvent('run_tests a', 'failed', 'targeted', 1000, { verificationPhase: 'integration', targetFiles: ['a.test.ts'], failed: 1, exitCode: 1 }),
    ]
    const result = getEffectiveVerifications(events)
    assert.equal(result.effective[0]!.verificationPhase, 'integration')
  })
})

describe('attribution — integration_conflict (Phase B advisory)', () => {
  const attr = createVerificationAttribution({ ownership: stubOwnership })

  function integrationFailure(): VerificationMetadata {
    return {
      command: 'run_tests src/x.test.ts',
      status: 'failed',
      scope: 'targeted',
      exitCode: 1,
      passed: 3,
      failed: 1,
      skipped: 0,
      durationMs: 100,
      verificationPhase: 'integration',
    }
  }

  it('classifies an integration-phase failure as non-blocking integration_conflict', () => {
    const result = attr.attribute(integrationFailure())
    assert.equal(result.attribution, 'integration_conflict')
    assert.equal(result.isBlocking, false)
  })

  it('a targeted failure WITHOUT integration phase still blocks (owned_failure)', () => {
    const owned = { ...integrationFailure(), verificationPhase: undefined }
    const result = attr.attribute(owned)
    assert.equal(result.attribution, 'owned_failure')
    assert.equal(result.isBlocking, true)
  })

  it('aggregate: Phase A passed + Phase B integration failure → non-blocking integration_conflict', () => {
    const phaseA: VerificationMetadata = {
      command: 'run_tests src/x.test.ts', status: 'passed', scope: 'targeted',
      exitCode: 0, passed: 4, failed: 0, skipped: 0, durationMs: 100, verificationPhase: 'isolated',
    }
    const result = attr.getAggregateAttribution([phaseA, integrationFailure()])
    assert.equal(result.attribution, 'integration_conflict')
    assert.equal(result.isBlocking, false)
  })

  it('aggregate: owned_failure still outranks integration_conflict', () => {
    const ownedFail: VerificationMetadata = {
      command: 'run_tests src/y.test.ts', status: 'failed', scope: 'targeted',
      exitCode: 1, passed: 0, failed: 2, skipped: 0, durationMs: 50,
    }
    const result = attr.getAggregateAttribution([ownedFail, integrationFailure()])
    assert.equal(result.attribution, 'owned_failure')
    assert.equal(result.isBlocking, true)
  })
})
