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
    // allowedTools now come from ProfileRegistry — includes read_section, repo_graph
    assert.ok(order.allowedTools.includes('inspect_project'))
    assert.ok(order.allowedTools.includes('repo_map'))
    assert.ok(order.allowedTools.includes('related_tests'))
    assert.ok(order.allowedTools.includes('read_section'))
    assert.ok(order.allowedTools.includes('repo_graph'))
    assert.ok(!order.allowedTools.includes('edit_file'))
    assert.deepEqual(order.disallowedTools, ['bash', 'write_file', 'edit_file', 'run_tests', 'delegate_task', 'delegate_batch'])
    assert.equal(order.budget.maxRetries, 2)
    // Read-only default turn budget (raised from 8 — flash has a 1M window).
    assert.equal(order.budget.maxTurns, 24)
    assert.equal(order.aggregationPolicy, 'primary_decides')
  })

  it('accepts all built-in registry profiles in work orders', () => {
    const architect = createReadOnlyWorkOrder({
      id: 'wo_architect',
      parentTurnId: 'turn_1',
      kind: 'review',
      profile: 'architect',
      objective: 'Review architectural boundaries in the worker registry implementation.',
      scope: { files: ['src/agent/profile-registry.ts'] },
    })
    const troubleshooter = createReadOnlyWorkOrder({
      id: 'wo_troubleshooter',
      parentTurnId: 'turn_1',
      kind: 'code_search',
      profile: 'troubleshooter',
      objective: 'Trace root cause across worker evidence and aggregation modules.',
      scope: { files: ['src/agent/worker-evidence.ts'] },
    })

    assert.equal(architect.profile, 'architect')
    assert.ok(architect.allowedTools.includes('lsp_goto_definition'))
    assert.equal(troubleshooter.profile, 'troubleshooter')
    assert.ok(troubleshooter.allowedTools.includes('grep'))
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

  it('skips non-result JSON before the WorkerResult packet', () => {
    const result = parseWorkerResult(`I inspected this scope {"note":"not the result"} and found:\n{
  "workOrderId": "wo_1",
  "status": "passed",
  "summary": "Worker result packet follows incidental JSON.",
  "findings": [],
  "artifacts": [],
  "changedFiles": [],
  "risks": [],
  "nextActions": []
}`, 'wo_1')

    assert.equal(result.status, 'passed')
    assert.equal(result.summary, 'Worker result packet follows incidental JSON.')
  })

  it('normalizes legacy string findings and fills optional arrays', () => {
    const result = parseWorkerResult(JSON.stringify({
      workOrderId: 'wo_1',
      status: 'passed',
      summary: 'Legacy worker packet was normalized.',
      findings: ['Coordinator creates isolated worker sessions.'],
      artifacts: ['Use ToolRegistry allowlist for workers.'],
    }), 'wo_1')

    assert.equal(result.findings[0]!.claim, 'Coordinator creates isolated worker sessions.')
    assert.equal(result.findings[0]!.confidence, 'medium')
    assert.deepEqual(result.changedFiles, [])
    assert.equal(result.artifacts[0]!.kind, 'note')
  })

  it('reports schema errors from the WorkerResult candidate, not incidental JSON', () => {
    // parseWorkerResult no longer throws on schema errors — it returns a blocked
    // result with the diagnostic error details, allowing the coordinator to surface
    // the failure without crashing the retry chain.
    const result = parseWorkerResult(`{"note":"incidental"}\n{
  "workOrderId": "wo_1",
  "status": "done",
  "summary": "Invalid result status"
}`, 'wo_1')
    assert.equal(result.status, 'blocked')
    // The diagnostic includes errors from ALL candidates; the important one
    // (invalid enum value "done") should be present somewhere in the output.
    const diag = result.artifacts[0]!.content as string
    assert.ok(diag.includes('done') || diag.includes('invalid_enum_value'),
      `expected blocked result to mention the "done" status error. Got: ${diag}`)
  })

  it('auto-fixes wrong workOrderId to expected one (fault tolerance for cheap models)', () => {
    const result = parseWorkerResult(JSON.stringify({
      workOrderId: 'other',
      status: 'passed',
      summary: 'wrong id',
      findings: [],
      artifacts: [],
      changedFiles: [],
      risks: [],
      nextActions: [],
    }), 'wo_1')
    assert.equal(result.workOrderId, 'wo_1')
    assert.equal(result.status, 'passed')
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
    assert.equal(mapWorkOrderKindToCapabilityTask('plan'), 'planning')
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
    // allowedTools now come from ProfileRegistry — includes read_section, repo_graph
    assert.ok(order.allowedTools.includes('edit_file'))
    assert.ok(order.allowedTools.includes('write_file'))
    assert.ok(order.allowedTools.includes('bash'))
    assert.ok(order.allowedTools.includes('run_tests'))
    assert.ok(order.allowedTools.includes('read_file'))
    assert.ok(order.allowedTools.includes('read_section'))
    assert.ok(order.allowedTools.includes('repo_graph'))
    assert.equal(order.disallowedTools.includes('delegate_task'), true)
    assert.equal(order.disallowedTools.includes('delegate_batch'), true)
    // Self-contained shards run a full implement+verify loop, so write workers
    // get a generous turn budget (raised from 14 — flash has a 1M window).
    assert.equal(order.budget.maxTurns, 32)
    assert.ok(order.dedupeKey.startsWith('write:'))
  })

  it('threads modelOverride through read-only and write work orders', () => {
    const ro = createReadOnlyWorkOrder({
      id: 'wo_ov_ro',
      parentTurnId: 'turn_1',
      kind: 'plan',
      profile: 'council_expert',
      objective: 'council seat',
      scope: {},
      modelOverride: { provider: 'glm', model: 'glm-4.6' },
    })
    assert.deepEqual(ro.modelOverride, { provider: 'glm', model: 'glm-4.6' })

    const rw = createWriteWorkOrder({
      id: 'wo_ov_rw',
      parentTurnId: 'turn_1',
      kind: 'patch_proposal',
      objective: 'patch',
      scope: { files: ['a.ts'] },
      modelOverride: { provider: 'deepseek', model: 'deepseek-v4-pro' },
    })
    assert.deepEqual(rw.modelOverride, { provider: 'deepseek', model: 'deepseek-v4-pro' })

    // Absent override → undefined (not an empty object).
    const none = createReadOnlyWorkOrder({
      id: 'wo_ov_none', parentTurnId: 'turn_1', kind: 'plan', profile: 'council_expert', objective: 'x', scope: {},
    })
    assert.equal(none.modelOverride, undefined)
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

  it('validates worker result evidence fields', () => {
    const result = parseWorkerResult(JSON.stringify({
      workOrderId: 'wo_1',
      status: 'passed',
      summary: 'Implemented retry policy',
      findings: [],
      artifacts: [],
      changedFiles: ['src/agent/turn-harness.ts'],
      risks: [],
      nextActions: [],
      evidenceStatus: 'verified',
    }), 'wo_1')

    assert.equal(result.evidenceStatus, 'verified')
  })

  it('defaults evidenceStatus to unverified when omitted', () => {
    const result = parseWorkerResult(JSON.stringify({
      workOrderId: 'wo_1',
      status: 'passed',
      summary: 'Read-only scan complete.',
      findings: [],
      artifacts: [],
      changedFiles: [],
      risks: [],
      nextActions: [],
    }), 'wo_1')

    assert.equal(result.evidenceStatus, 'unverified')
  })

  it('includes evidenceStatus in blocked worker result', () => {
    const order = createReadOnlyWorkOrder({
      id: 'wo_blocked',
      parentTurnId: 'turn_1',
      kind: 'review',
      profile: 'reviewer',
      objective: 'Review risk.',
      scope: {},
    })

    const result = buildBlockedWorkerResult(order, 'Parse error')
    assert.equal(result.evidenceStatus, 'blocked')
  })

  it('creates work order without domain (backward compatible)', () => {
    const order = createReadOnlyWorkOrder({
      id: 'wo_nodomain',
      parentTurnId: 'turn_1',
      kind: 'code_search',
      profile: 'code_scout',
      objective: 'Scan codebase.',
      scope: { files: ['src/main.tsx'] },
    })
    assert.equal(order.domain, undefined)
  })

  it('creates work order with domain field', () => {
    const order = createReadOnlyWorkOrder({
      id: 'wo_domain',
      parentTurnId: 'turn_1',
      kind: 'code_search',
      profile: 'code_scout',
      objective: 'Analyze TUI components.',
      scope: { files: ['src/tui/app.tsx'] },
      domain: 'frontend',
    })
    assert.equal(order.domain, 'frontend')
  })

  it('creates write work order with domain field', () => {
    const order = createWriteWorkOrder({
      id: 'wo_write_domain',
      parentTurnId: 'turn_1',
      kind: 'patch_proposal',
      objective: 'Fix prompt engine.',
      scope: { files: ['src/prompt/engine.ts'] },
      domain: 'prompt',
    })
    assert.equal(order.domain, 'prompt')
    assert.equal(order.profile, 'patcher')
  })

  // ─── P0-A1 fail-closed: authority typo → deny-all ──────────
  it('authority typo (read-only) → deny-all (empty allowedTools), NOT profile full set', () => {
    const order = createReadOnlyWorkOrder({
      id: 'wo_auth_typo',
      parentTurnId: 'turn_1',
      kind: 'code_search',
      profile: 'code_scout',
      objective: 'Search something.',
      scope: {},
      authority: 'tianfuu',  // typo — no such domain
    })
    assert.equal(order.allowedTools.length, 0, 'unknown authority should produce empty allowedTools (deny-all)')
  })

  it('authority typo (write) → deny-all (empty allowedTools)', () => {
    const order = createWriteWorkOrder({
      id: 'wo_auth_typo_write',
      parentTurnId: 'turn_1',
      kind: 'patch_proposal',
      objective: 'Patch something.',
      scope: {},
      authority: 'nonexistent_domain',
    })
    assert.equal(order.allowedTools.length, 0, 'unknown authority should produce empty allowedTools (deny-all)')
  })

  it('valid authority intersects with profile tools correctly', () => {
    const order = createReadOnlyWorkOrder({
      id: 'wo_auth_valid',
      parentTurnId: 'turn_1',
      kind: 'code_search',
      profile: 'code_scout',
      objective: 'Search something.',
      scope: {},
      authority: 'tianquan',  // valid built-in domain
    })
    assert.ok(order.allowedTools.length > 0, 'valid authority should produce non-empty intersection')
  })

  // ── Wave 1: retryBackoffMs / maxRetryBackoffMs ──────────────────

  it('WorkerBudget defaults retryBackoffMs to 10000 and maxRetryBackoffMs to 300000', () => {
    const order = createReadOnlyWorkOrder({
      id: 'wo_backoff',
      parentTurnId: 'turn_1',
      kind: 'code_search',
      profile: 'code_scout',
      objective: 'Search something.',
      scope: {},
    })
    assert.equal(order.budget.retryBackoffMs, 10000)
    assert.equal(order.budget.maxRetryBackoffMs, 300000)
  })

  it('WorkerBudget allows overriding retryBackoffMs and maxRetryBackoffMs', () => {
    const order = createReadOnlyWorkOrder({
      id: 'wo_backoff_custom',
      parentTurnId: 'turn_1',
      kind: 'code_search',
      profile: 'code_scout',
      objective: 'Search something.',
      scope: {},
      budget: { retryBackoffMs: 5000, maxRetryBackoffMs: 60000 },
    })
    assert.equal(order.budget.retryBackoffMs, 5000)
    assert.equal(order.budget.maxRetryBackoffMs, 60000)
  })

  it('write work order also gets backoff defaults', () => {
    const order = createWriteWorkOrder({
      id: 'wo_write_backoff',
      parentTurnId: 'turn_1',
      kind: 'patch_proposal',
      profile: 'patcher',
      objective: 'Patch something.',
      scope: {},
    })
    assert.equal(order.budget.retryBackoffMs, 10000)
    assert.equal(order.budget.maxRetryBackoffMs, 300000)
  })
})
