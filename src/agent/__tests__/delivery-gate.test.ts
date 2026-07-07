import test from 'node:test'
import assert from 'node:assert/strict'
import type { EvidenceState } from '../evidence.js'
import { buildDeliveryGate } from '../delivery-gate.js'

function state(overrides: Partial<EvidenceState>): EvidenceState {
  return {
    filesRead: new Set(),
    filesModified: new Set(),
    verifications: [],
    deliveryStatus: 'unverified',
    impactedFiles: new Set(),
    impactedTests: new Set(),
    fileVerificationLevels: new Map(),
    ...overrides,
  }
}

test('allows verified delivery after modified files have passed verification', () => {
  const result = buildDeliveryGate(state({
    filesModified: new Set(['src/a.ts']),
    deliveryStatus: 'verified',
    verifications: [{
      command: 'npm test',
      status: 'passed',
      scope: 'targeted',
      exitCode: 0,
      passed: 3,
      failed: 0,
      skipped: 0,
      durationMs: 12,
    }],
  }))

  assert.equal(result.status, 'verified')
  assert.equal(result.canClaimComplete, true)
  assert.equal(result.severity, 'ok')
})

test('marks modified files without verification as unverified delivery', () => {
  const result = buildDeliveryGate(state({
    filesModified: new Set(['src/a.ts']),
    deliveryStatus: 'unverified',
  }))

  assert.equal(result.status, 'unverified')
  assert.equal(result.canClaimComplete, false)
  assert.equal(result.severity, 'warn')
  assert.match(result.message, /Unverified changes/)
  assert.match(result.message, /src\/a\.ts/)
})

test('marks failed verification as failed delivery', () => {
  const result = buildDeliveryGate(state({
    filesModified: new Set(['src/a.ts']),
    deliveryStatus: 'failed',
    verifications: [{
      command: 'npm test',
      status: 'failed',
      scope: 'targeted',
      exitCode: 1,
      passed: 1,
      failed: 2,
      skipped: 0,
      durationMs: 22,
    }],
  }))

  assert.equal(result.status, 'failed')
  assert.equal(result.canClaimComplete, false)
  assert.equal(result.severity, 'error')
  assert.match(result.message, /Verification failed/)
  assert.match(result.message, /npm test/)
})

test('does not require verification for read-only analysis', () => {
  const result = buildDeliveryGate(state({
    filesRead: new Set(['src/a.ts']),
    deliveryStatus: 'unverified',
  }))

  assert.equal(result.status, 'verified')
  assert.equal(result.canClaimComplete, true)
  assert.equal(result.severity, 'ok')
})
