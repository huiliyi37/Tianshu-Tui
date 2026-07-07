import test from 'node:test'
import assert from 'node:assert/strict'
import type { EvidenceState } from '../evidence.js'
import { buildDeliveryGate } from '../delivery-gate.js'
import { buildExecutionGuidance } from '../execution-guidance.js'
import { verifyWorkerEvidence } from '../worker-evidence.js'
import type { WorkerResult } from '../work-order.js'
import { evaluateMcpPolicy } from '../../mcp/policy.js'
import { assessToolRisk } from '../approval-risk.js'

function evidenceState(overrides: Partial<EvidenceState>): EvidenceState {
  return {
    filesRead: new Set(),
    filesModified: new Set(),
    verifications: [],
    deliveryStatus: 'unverified',
    impactedFiles: new Set(),
    impactedTests: new Set(),
    ...overrides,
  }
}

function workerResult(overrides: Partial<WorkerResult>): WorkerResult {
  return {
    workOrderId: 'wo_trust_closure',
    status: 'passed',
    summary: 'worker completed changes',
    findings: [],
    artifacts: [],
    changedFiles: [],
    risks: [],
    nextActions: [],
    evidenceStatus: 'unverified',
    ...overrides,
  }
}

test('Execution Trust Closure blocks completion when modified files lack verification', () => {
  const gate = buildDeliveryGate(evidenceState({
    filesModified: new Set(['src/agent/loop.ts']),
    deliveryStatus: 'unverified',
  }))

  assert.equal(gate.canClaimComplete, false)
  assert.equal(gate.status, 'unverified')
  assert.equal(gate.severity, 'warn')
  assert.match(gate.blockingReason ?? '', /modified without passing verification evidence/i)
  assert.match(gate.nextAction ?? '', /targeted tests|typecheck|build/i)
})

test('Execution Trust Closure emits anchor-first blocked guidance for repeated failed trajectory', () => {
  const guidance = buildExecutionGuidance({
    doomLevel: 'blocked',
    trajectory: [
      { tool: 'edit_file', target: 'src/agent/loop.ts', status: 'failed', errorClass: 'assertion' },
      { tool: 'edit_file', target: 'src/agent/loop.ts', status: 'failed', errorClass: 'assertion' },
      { tool: 'edit_file', target: 'src/agent/loop.ts', status: 'failed', errorClass: 'assertion' },
    ],
  })

  assert.ok(guidance)
  assert.equal(guidance.severity, 'blocked')
  assert.match(guidance.message, /Strategy shift \(blocked\)/)
  assert.match(guidance.message, /read_file the target region first/)
  assert.match(guidance.boundaryCondition, /Do not repeat/)
})

test('Execution Trust Closure blocks or fails worker changes through evidence gate', () => {
  const missingVerification = verifyWorkerEvidence(workerResult({
    changedFiles: ['src/agent/worker-evidence.ts'],
    evidenceStatus: 'unverified',
  }))

  assert.equal(missingVerification.status, 'blocked')
  assert.equal(missingVerification.evidenceStatus, 'blocked')
  assert.ok(missingVerification.risks.some(r => r.includes('unverified')))

  const failedVerification = verifyWorkerEvidence(workerResult({
    changedFiles: ['src/agent/worker-evidence.ts'],
    evidenceStatus: 'verified',
    verification: {
      command: 'npx tsx --test src/agent/__tests__/worker-evidence.test.ts',
      status: 'failed',
      scope: 'targeted',
      exitCode: 1,
      passed: 0,
      failed: 1,
      skipped: 0,
      durationMs: 42,
    },
  }))

  assert.equal(failedVerification.status, 'failed')
  assert.equal(failedVerification.evidenceStatus, 'failed')
  assert.ok(failedVerification.risks.some(r => r.includes('worker verification failed')))
})

test('Execution Trust Closure requires confirmation or raises risk for MCP write/execute tools', () => {
  const writePolicy = evaluateMcpPolicy({
    toolName: 'mcp__unknown__write_file',
    trustedServers: [],
    blockedTools: [],
    allowedTools: [],
    mustConfirmCapabilities: ['write', 'execute'],
  })
  const executePolicy = evaluateMcpPolicy({
    toolName: 'mcp__trusted__run_command',
    trustedServers: ['trusted'],
    blockedTools: [],
    allowedTools: [],
    mustConfirmCapabilities: ['write', 'execute'],
  })
  const risk = assessToolRisk('mcp__unknown__write_file', {})

  assert.equal(writePolicy.action, 'confirm')
  assert.equal(writePolicy.capability, 'write')
  assert.equal(executePolicy.action, 'confirm')
  assert.equal(executePolicy.capability, 'execute')
  assert.equal(risk.level, 'medium')
  assert.ok(risk.reasons.some(r => r.includes('MCP write-capable tool')))
})
