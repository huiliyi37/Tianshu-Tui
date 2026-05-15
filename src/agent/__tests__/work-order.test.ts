import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  buildBlockedWorkerResult,
  createReadOnlyWorkOrder,
  createWriteWorkOrder,
  mapWorkOrderKindToCapabilityTask,
  parseWorkerResult,
  READ_ONLY_WORKER_TOOLS,
  WRITE_WORKER_TOOLS,
} from '../work-order.js'

describe('work-order contract', () => {
  it('creates a read-only code_search work order with safe defaults', () => {
    const order = createReadOnlyWorkOrder({
      id: 'wo_1',
      parentTurnId: 'turn_1',
      kind: 'code_search',
      profile: 'code_scout',
      objective: 'Find where model routing is currently configured.',
      scope: { files: ['src/main.tsx'] },
    })

    assert.equal(order.id, 'wo_1')
    assert.equal(order.kind, 'code_search')
    assert.deepEqual(order.allowedTools, READ_ONLY_WORKER_TOOLS)
    assert.deepEqual(order.disallowedTools, ['bash', 'write_file', 'edit_file', 'run_tests', 'delegate_task'])
    assert.equal(order.budget.maxRetries, 1)
    assert.equal(order.aggregationPolicy, 'primary_decides')
  })

  it('parses a fenced WorkerResult JSON packet', () => {
    const result = parseWorkerResult(`Here is the packet:\n\n\`\`\`json
{
  "workOrderId": "wo_1",
  "status": "passed",
  "summary": "Model routing is only configured in main.",
  "findings": [
    {
      "claim": "main.tsx constructs the active AgentLoop.",
      "evidence": "src/main.tsx creates PromptEngine and AgentLoop inside useMemo.",
      "confidence": "high"
    }
  ],
  "artifacts": [
    {
      "kind": "note",
      "title": "Runtime seam",
      "content": "Inject coordinator next to the existing AgentLoop construction."
    }
  ],
  "changedFiles": [],
  "risks": [],
  "nextActions": ["Create a coordinator factory"]
}
\`\`\``, 'wo_1')

    assert.equal(result.status, 'passed')
    assert.equal(result.findings[0]!.confidence, 'high')
    assert.deepEqual(result.changedFiles, [])
  })

  it('rejects a packet for the wrong work order', () => {
    assert.throws(() => parseWorkerResult(JSON.stringify({
      workOrderId: 'other',
      status: 'passed',
      summary: 'wrong id',
      findings: [],
      artifacts: [],
      changedFiles: [],
      risks: [],
      nextActions: [],
    }), 'wo_1'), /does not match/)
  })

  it('builds a blocked result without leaking raw transcript content', () => {
    const order = createReadOnlyWorkOrder({
      id: 'wo_1',
      parentTurnId: 'turn_1',
      kind: 'review',
      profile: 'reviewer',
      objective: 'Review coordinator risk.',
      scope: {},
    })

    const result = buildBlockedWorkerResult(order, 'Worker result was not valid JSON')

    assert.equal(result.status, 'blocked')
    assert.equal(result.summary, 'Worker blocked: Worker result was not valid JSON')
    assert.equal(result.findings.length, 0)
    assert.ok(result.risks.includes('Worker did not return schema-valid JSON'))
  })

  it('maps work order kinds to existing capability task names', () => {
    assert.equal(mapWorkOrderKindToCapabilityTask('code_search'), 'repo_summarization')
    assert.equal(mapWorkOrderKindToCapabilityTask('review'), 'risky_refactor')
    assert.equal(mapWorkOrderKindToCapabilityTask('verify'), 'test_failure_diagnosis')
  })

  it('creates a write-capable work order with expanded tool allowlist', () => {
    const order = createWriteWorkOrder({
      id: 'wo_write',
      parentTurnId: 'turn_1',
      kind: 'patch_proposal',
      objective: 'Fix the null check in coordinator.',
      scope: { files: ['src/agent/coordinator.ts'] },
    })

    assert.equal(order.profile, 'patcher')
    assert.deepEqual(order.allowedTools, [...WRITE_WORKER_TOOLS])
    assert.equal(order.disallowedTools.includes('delegate_task'), true)
    assert.equal(order.budget.maxTurns, 8)
    assert.ok(order.dedupeKey.startsWith('write:'))
  })

  it('accepts patchSummary in worker result schema', () => {
    const result = parseWorkerResult(JSON.stringify({
      workOrderId: 'wo_1',
      status: 'passed',
      summary: 'Applied fix.',
      patchSummary: 'Changed null check on line 42.',
      findings: [],
      artifacts: [],
      changedFiles: ['src/agent/coordinator.ts'],
      risks: [],
      nextActions: [],
    }), 'wo_1')

    assert.equal(result.patchSummary, 'Changed null check on line 42.')
    assert.deepEqual(result.changedFiles, ['src/agent/coordinator.ts'])
  })
})
