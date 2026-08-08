import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createTeamOrchestrateTool } from '../team-orchestrate.js'
import { createPlanTaskTool } from '../plan-task.js'
import type { CoordinatorRun, DelegationCoordinator, DelegationRequest } from '../../agent/coordinator.js'
import type { PlanExecutorDeps } from '../../agent/plan-executor.js'
import { storePlan, consumePlan, getStoredPlan, clearPlan } from '../../agent/plan-store.js'
import { getWaveResults, clearWaveResults } from '../../agent/wave-results-store.js'

type RunResult = CoordinatorRun['results'][number]

function mkResult(over: Partial<RunResult> = {}): RunResult {
  return {
    workOrderId: 'w',
    status: 'passed',
    summary: 's',
    findings: [],
    artifacts: [],
    changedFiles: [],
    risks: [],
    nextActions: [],
    evidenceStatus: 'verified',
    ...over,
  }
}

function run(results: RunResult[] = [], packet = 'stub'): CoordinatorRun {
  return { status: 'completed', results, packet }
}

function twoWavePlan(sessionId: string): string {
  // T2 depends on T1 → grouping yields wave0=[T1], wave1=[T2].
  return JSON.stringify({
    version: 1,
    objective: 'bridge two waves',
    tasks: [
      { id: 'T1', title: 'edit foo', objective: 'Modify src/agent/foo.ts', profile: 'patcher', kind: 'patch_proposal', files: ['src/agent/foo.ts'], dependsOn: [], riskTier: 'low' },
      { id: 'T2', title: 'edit bar', objective: 'Modify src/agent/bar.ts', profile: 'patcher', kind: 'patch_proposal', files: ['src/agent/bar.ts'], dependsOn: ['T1'], riskTier: 'low' },
    ],
    source: 'plan_task',
    createdAt: Date.now(),
  })
}

// ── plan_task writes wave results to the session-scoped store ─────────────

test('plan_task(execute:true) records wave results into the session store', async () => {
  const sessionId = 'bridge-plan-write'
  clearWaveResults(sessionId)
  consumePlan(sessionId)

  const executorDeps: PlanExecutorDeps = {
    delegateBatch: async () => run([mkResult({ workOrderId: 'team:S1', status: 'passed' })], 'plan-wave0'),
  }
  const tool = createPlanTaskTool({
    getCoordinator: () => ({}) as unknown as DelegationCoordinator,
    getExecutorDeps: () => executorDeps,
    getSessionId: () => sessionId,
  })

  const result = await tool.execute({
    input: { objective: 'refactor the cache module for clarity and add tests', execute: true },
    cwd: process.cwd(),
    toolUseId: 'pt-bridge',
    sessionId,
  })

  assert.notEqual(result.isError, true)
  const stored = getWaveResults(sessionId)
  assert.ok(stored, 'plan_task should write its wave results to the session store')
  assert.equal(stored!.length, 1)
  assert.equal(stored![0]!.workOrderId, 'team:S1')
})

// ── cross-tool bridge: a failed wave-0 result blocks a dependent wave-1 task
//    across SEPARATE tool instances (the old per-instance closure could not). ──

test('wave-0 failure bridges across tool instances to block the dependent wave-1 task', async () => {
  const sessionId = 'bridge-cross-tool'
  clearWaveResults(sessionId)
  consumePlan(sessionId)
  // Simulate plan_task's bridge: the serialized plan is in the session store.
  storePlan(twoWavePlan(sessionId), sessionId)

  // Wave 0 (tool instance A): dispatch T1, report it FAILED.
  const toolA = createTeamOrchestrateTool({
    delegateBatch: async () => run([mkResult({ workOrderId: 'team:T1', status: 'failed', summary: 'crashed' })], 'wave0'),
  })
  const r0 = await toolA.execute({
    input: { mode: 'standard', objective: 'force: bridge wave 0', fromWave: 0 },
    cwd: process.cwd(),
    toolUseId: 'tu-bridge-0',
    sessionId,
  })
  assert.equal(r0.isError, false)
  const stored = getWaveResults(sessionId)
  assert.ok(stored && stored.length === 1 && stored[0]!.status === 'failed', 'wave-0 failure should be stored session-scoped')

  // Wave 1 (a DIFFERENT tool instance): auto-consume the plan, read prior results
  // from the store, and block T2 because its dependency T1 failed.
  let captured: DelegationRequest[] = []
  const toolB = createTeamOrchestrateTool({
    delegateBatch: async requests => { captured = requests; return run([], 'wave1') },
  })
  const r1 = await toolB.execute({
    input: { mode: 'standard', objective: 'force: bridge wave 1', fromWave: 1 },
    cwd: process.cwd(),
    toolUseId: 'tu-bridge-1',
    sessionId,
  })
  assert.equal(r1.isError, false)
  assert.ok(!captured.some(req => req.parentTurnId.includes('T2')), 'T2 must be blocked by the bridged wave-0 failure')
})

// ── 跨波条件边（审查 F1）：skip 记 skipped 不阻塞 / alternate 备选已过放行 /
//    备选未决等待——与 coordinator intra-batch 语义对齐 ───────────────────────

function edgePlan(sessionId: string, t2Edge: unknown): string {
  return JSON.stringify({
    version: 1,
    objective: 'cross-wave conditional edges',
    tasks: [
      { id: 'T1', title: 'scout', objective: 'Explore codebase', profile: 'code_scout', kind: 'code_search', files: [], dependsOn: [], riskTier: 'low' },
      { id: 'T3', title: 'scout2', objective: 'Explore alt', profile: 'code_scout', kind: 'code_search', files: [], dependsOn: [], riskTier: 'low' },
      { id: 'T2', title: 'edit', objective: 'Modify src/agent/foo.ts', profile: 'patcher', kind: 'patch_proposal', files: ['src/agent/foo.ts'], dependsOn: [t2Edge], riskTier: 'low' },
    ],
    source: 'plan_task',
    createdAt: Date.now(),
  })
}

test('wave-0 failure with onFailure=skip bridges as skipped, not blocked', async () => {
  const sessionId = 'bridge-edge-skip'
  clearWaveResults(sessionId)
  consumePlan(sessionId)
  storePlan(edgePlan(sessionId, { dependsOn: 'T1', onFailure: 'skip' }), sessionId)

  const toolA = createTeamOrchestrateTool({
    delegateBatch: async () => run([mkResult({ workOrderId: 'team:T1', status: 'failed', summary: 'crashed' })], 'wave0'),
  })
  const r0 = await toolA.execute({
    input: { mode: 'standard', objective: 'force: edge skip wave 0', fromWave: 0 },
    cwd: process.cwd(),
    toolUseId: 'tu-eskip-0',
    sessionId,
  })
  assert.equal(r0.isError, false)

  let captured: DelegationRequest[] = []
  const toolB = createTeamOrchestrateTool({
    delegateBatch: async requests => { captured = requests; return run([], 'wave1') },
  })
  const r1 = await toolB.execute({
    input: { mode: 'standard', objective: 'force: edge skip wave 1', fromWave: 1 },
    cwd: process.cwd(),
    toolUseId: 'tu-eskip-1',
    sessionId,
  })
  assert.equal(r1.isError, false)
  assert.ok(!captured.some(req => req.parentTurnId.includes('T2')), 'onFailure=skip 的任务不得派发')
  assert.match(String(r1.content), /跳过/, 'skip 语义记为跳过（非阻塞）')
  assert.doesNotMatch(String(r1.content), /T2: blocked/, 'skip 任务不得记为 blocked')
  clearPlan(sessionId)
})

test('wave-0 failure with onFailure=alternate passes when the alternate already passed', async () => {
  const sessionId = 'bridge-edge-alt-pass'
  clearWaveResults(sessionId)
  consumePlan(sessionId)
  storePlan(edgePlan(sessionId, { dependsOn: 'T1', onFailure: 'alternate', alternateOrderId: 'T3' }), sessionId)

  const toolA = createTeamOrchestrateTool({
    delegateBatch: async () => run([
      mkResult({ workOrderId: 'team:T1', status: 'failed', summary: 'crashed' }),
      mkResult({ workOrderId: 'team:T3', status: 'passed', summary: 'alt ok' }),
    ], 'wave0'),
  })
  const r0 = await toolA.execute({
    input: { mode: 'standard', objective: 'force: edge alt wave 0', fromWave: 0 },
    cwd: process.cwd(),
    toolUseId: 'tu-ealt-0',
    sessionId,
  })
  assert.equal(r0.isError, false)

  let captured: DelegationRequest[] = []
  const toolB = createTeamOrchestrateTool({
    delegateBatch: async requests => { captured = requests; return run([], 'wave1') },
  })
  const r1 = await toolB.execute({
    input: { mode: 'standard', objective: 'force: edge alt wave 1', fromWave: 1 },
    cwd: process.cwd(),
    toolUseId: 'tu-ealt-1',
    sessionId,
  })
  assert.equal(r1.isError, false)
  const req = captured.find(r => r.parentTurnId.includes('T2'))
  assert.ok(req, `备选已通过时必须放行 T2，实际 captured=${JSON.stringify(captured.map(c => c.parentTurnId))}`)
  const deps = req!.dependencies ?? []
  assert.ok(!deps.some(d => (typeof d === 'string' ? d : d.dependsOn).endsWith('T1')), '失败主依赖（备选已过）不得残留在请求里，否则 coordinator 会误拦')
  clearPlan(sessionId)
})

test('wave-0 failure with onFailure=alternate waits when the alternate is pending', async () => {
  const sessionId = 'bridge-edge-alt-pending'
  clearWaveResults(sessionId)
  consumePlan(sessionId)
  storePlan(edgePlan(sessionId, { dependsOn: 'T1', onFailure: 'alternate', alternateOrderId: 'T3' }), sessionId)

  const toolA = createTeamOrchestrateTool({
    delegateBatch: async () => run([mkResult({ workOrderId: 'team:T1', status: 'failed', summary: 'crashed' })], 'wave0'),
  })
  await toolA.execute({
    input: { mode: 'standard', objective: 'force: edge altpend wave 0', fromWave: 0 },
    cwd: process.cwd(),
    toolUseId: 'tu-ealtp-0',
    sessionId,
  })

  let captured: DelegationRequest[] = []
  const toolB = createTeamOrchestrateTool({
    delegateBatch: async requests => { captured = requests; return run([], 'wave1') },
  })
  const r1 = await toolB.execute({
    input: { mode: 'standard', objective: 'force: edge altpend wave 1', fromWave: 1 },
    cwd: process.cwd(),
    toolUseId: 'tu-ealtp-1',
    sessionId,
  })
  assert.equal(r1.isError, false)
  assert.ok(!captured.some(req => req.parentTurnId.includes('T2')), '备选未决时不得派发')
  assert.match(String(r1.content), /waiting for alternate/, '备选未决记为等待')
  clearPlan(sessionId)
})

test('wave-0 failure with onFailure=alternate skips when the alternate also failed', async () => {
  const sessionId = 'bridge-edge-alt-fail'
  clearWaveResults(sessionId)
  consumePlan(sessionId)
  storePlan(edgePlan(sessionId, { dependsOn: 'T1', onFailure: 'alternate', alternateOrderId: 'T3' }), sessionId)

  const toolA = createTeamOrchestrateTool({
    delegateBatch: async () => run([
      mkResult({ workOrderId: 'team:T1', status: 'failed', summary: 'crashed' }),
      mkResult({ workOrderId: 'team:T3', status: 'failed', summary: 'alt crashed' }),
    ], 'wave0'),
  })
  await toolA.execute({
    input: { mode: 'standard', objective: 'force: edge altfail wave 0', fromWave: 0 },
    cwd: process.cwd(),
    toolUseId: 'tu-ealtf-0',
    sessionId,
  })

  let captured: DelegationRequest[] = []
  const toolB = createTeamOrchestrateTool({
    delegateBatch: async requests => { captured = requests; return run([], 'wave1') },
  })
  const r1 = await toolB.execute({
    input: { mode: 'standard', objective: 'force: edge altfail wave 1', fromWave: 1 },
    cwd: process.cwd(),
    toolUseId: 'tu-ealtf-1',
    sessionId,
  })
  assert.equal(r1.isError, false)
  assert.ok(!captured.some(req => req.parentTurnId.includes('T2')), '备选也失败时不得派发')
  assert.match(String(r1.content), /跳过/, '备选也失败记 skipped')
  assert.doesNotMatch(String(r1.content), /T2: blocked/, '备选也失败不是 blocked')
  clearPlan(sessionId)
})

test('mixed failure edges: skip dependency wins over plain failure (coordinator priority)', async () => {
  const sessionId = 'bridge-edge-mixed'
  clearWaveResults(sessionId)
  consumePlan(sessionId)
  storePlan(JSON.stringify({
    version: 1,
    objective: 'mixed failure edges',
    tasks: [
      { id: 'T1', title: 'scout', objective: 'Explore codebase', profile: 'code_scout', kind: 'code_search', files: [], dependsOn: [], riskTier: 'low' },
      { id: 'T4', title: 'scout4', objective: 'Explore more', profile: 'code_scout', kind: 'code_search', files: [], dependsOn: [], riskTier: 'low' },
      { id: 'T2', title: 'edit', objective: 'Modify src/agent/foo.ts', profile: 'patcher', kind: 'patch_proposal', files: ['src/agent/foo.ts'], dependsOn: ['T1', { dependsOn: 'T4', onFailure: 'skip' }], riskTier: 'low' },
    ],
    source: 'plan_task',
    createdAt: Date.now(),
  }), sessionId)

  const toolA = createTeamOrchestrateTool({
    delegateBatch: async () => run([
      mkResult({ workOrderId: 'team:T1', status: 'failed', summary: 'crashed' }),
      mkResult({ workOrderId: 'team:T4', status: 'failed', summary: 'also crashed' }),
    ], 'wave0'),
  })
  await toolA.execute({
    input: { mode: 'standard', objective: 'force: mixed wave 0', fromWave: 0 },
    cwd: process.cwd(),
    toolUseId: 'tu-mixed-0',
    sessionId,
  })

  let captured: DelegationRequest[] = []
  const toolB = createTeamOrchestrateTool({
    delegateBatch: async requests => { captured = requests; return run([], 'wave1') },
  })
  const r1 = await toolB.execute({
    input: { mode: 'standard', objective: 'force: mixed wave 1', fromWave: 1 },
    cwd: process.cwd(),
    toolUseId: 'tu-mixed-1',
    sessionId,
  })
  assert.equal(r1.isError, false)
  assert.ok(!captured.some(req => req.parentTurnId.includes('T2')), '混合失败边不得派发')
  assert.match(String(r1.content), /跳过/, '任一 skip 依赖失败 → 整体 skipped（coordinator 优先级）')
  assert.doesNotMatch(String(r1.content), /T2: blocked/, '混合边不得记 blocked')
  clearPlan(sessionId)
})

test('skipped task propagates to downstream tasks in the next wave (chain semantics)', async () => {
  const sessionId = 'bridge-edge-chain'
  clearWaveResults(sessionId)
  consumePlan(sessionId)
  storePlan(JSON.stringify({
    version: 1,
    objective: 'skip chain propagation',
    tasks: [
      { id: 'T1', title: 'scout', objective: 'Explore codebase', profile: 'code_scout', kind: 'code_search', files: [], dependsOn: [], riskTier: 'low' },
      { id: 'T2', title: 'edit', objective: 'Modify src/agent/foo.ts', profile: 'patcher', kind: 'patch_proposal', files: ['src/agent/foo.ts'], dependsOn: [{ dependsOn: 'T1', onFailure: 'skip' }], riskTier: 'low' },
      { id: 'T5', title: 'edit5', objective: 'Modify src/agent/bar.ts', profile: 'patcher', kind: 'patch_proposal', files: ['src/agent/bar.ts'], dependsOn: ['T2'], riskTier: 'low' },
    ],
    source: 'plan_task',
    createdAt: Date.now(),
  }), sessionId)

  const toolA = createTeamOrchestrateTool({
    delegateBatch: async () => run([mkResult({ workOrderId: 'team:T1', status: 'failed', summary: 'crashed' })], 'wave0'),
  })
  await toolA.execute({
    input: { mode: 'standard', objective: 'force: chain wave 0', fromWave: 0 },
    cwd: process.cwd(),
    toolUseId: 'tu-chain-0',
    sessionId,
  })

  // wave1: T2 skipped（T1 失败）→ 合成结果进 wave results
  const toolB = createTeamOrchestrateTool({
    delegateBatch: async () => run([], 'wave1'),
  })
  await toolB.execute({
    input: { mode: 'standard', objective: 'force: chain wave 1', fromWave: 1 },
    cwd: process.cwd(),
    toolUseId: 'tu-chain-1',
    sessionId,
  })

  // wave2: T5 依赖 T2（已 skipped=blocked）→ 不得派发，记 blocked（感知链式传播）
  let captured: DelegationRequest[] = []
  const toolC = createTeamOrchestrateTool({
    delegateBatch: async requests => { captured = requests; return run([], 'wave2') },
  })
  const r2 = await toolC.execute({
    input: { mode: 'standard', objective: 'force: chain wave 2', fromWave: 2 },
    cwd: process.cwd(),
    toolUseId: 'tu-chain-2',
    sessionId,
  })
  assert.equal(r2.isError, false)
  assert.ok(!captured.some(req => req.parentTurnId.includes('T5')), '下游任务必须感知上游 skip，不得派发')
  assert.match(String(r2.content), /T5: blocked/, '下游按失败依赖记 blocked')
  clearPlan(sessionId)
})

// ── Phase D: an explicit planJson clears any stale stored plan ──────────────

test('explicit planJson clears a stale stored plan and is not re-stored', async () => {
  const sessionId = 'bridge-stale-clean'
  clearWaveResults(sessionId)
  consumePlan(sessionId)
  // A stale plan left over from a prior run.
  storePlan('STALE-NOT-VALID-JSON', sessionId)

  const explicit = JSON.stringify({
    version: 1,
    objective: 'explicit run',
    tasks: [
      { id: 'T1', title: 'edit foo', objective: 'Modify src/agent/foo.ts', profile: 'patcher', kind: 'patch_proposal', files: ['src/agent/foo.ts'], dependsOn: [], riskTier: 'low' },
    ],
    source: 'plan_task',
    createdAt: Date.now(),
  })
  const tool = createTeamOrchestrateTool({ delegateBatch: async () => run([], 'explicit') })
  const result = await tool.execute({
    input: { mode: 'standard', objective: 'force: run explicit plan', planJson: explicit },
    cwd: process.cwd(),
    toolUseId: 'tu-stale',
    sessionId,
  })

  assert.equal(result.isError, false)
  // Stale plan dropped; explicit planJson takes priority and is NOT re-stored.
  assert.equal(getStoredPlan(sessionId), null)
})

// ── T5 回归：多任务计划经完整桥接链路不坍缩 ────────────────────────────────
// docs/analysis/2026-07-29-team-mode-e2e-repro-and-gaps.md §四 #5：e2e 实测
// 观察到「7 任务 2 波计划进 team 后坍缩成单任务单波 + files:[]」。归因见
// src/agent/__tests__/plan-collapse-t5.test.ts —— 坍缩发生在 plan 生成侧
// （decomposeObjective 对 files 缺席的退化），桥接与分组链路本身忠实。
// 本测试锁定端到端不回退：storePlan → team_orchestrate 派发层看到全部任务与波次。

test('T5: 7 任务多波 UnifiedPlan 经 storePlan → team_orchestrate 原样到达派发层', async () => {
  const sessionId = 't5-e2e-seven'
  clearWaveResults(sessionId)
  consumePlan(sessionId)

  const patchers = ['a', 'b', 'c', 'd', 'e', 'f'].map((m, i) => ({
    id: `T${i + 2}`,
    title: `edit module ${m}`,
    objective: `Modify src/mod${m}/impl.ts`,
    profile: 'patcher',
    kind: 'patch_proposal',
    files: [`src/mod${m}/impl.ts`],
    dependsOn: ['T1'],
    riskTier: 'low',
  }))
  storePlan(JSON.stringify({
    version: 1,
    objective: 'seven task multi wave plan',
    tasks: [
      { id: 'T1', title: 'explore', objective: 'Explore codebase', profile: 'code_scout', kind: 'code_search', files: [], dependsOn: [], riskTier: 'low' },
      ...patchers,
    ],
    source: 'plan_task',
    createdAt: Date.now(),
  }), sessionId)

  let captured: DelegationRequest[] = []
  const tool = createTeamOrchestrateTool({
    delegateBatch: async requests => {
      captured = requests
      return run(requests.map(r => mkResult({ workOrderId: r.parentTurnId, status: 'passed' })), 'wave0')
    },
  })
  const result = await tool.execute({
    input: { mode: 'standard', objective: 'force: t5 seven task regression', fromWave: 0 },
    cwd: process.cwd(),
    toolUseId: 'tu-t5-seven',
    sessionId,
  })

  assert.equal(result.isError, false)
  // 波次结构完整：scout 先行 + 写工按每波上限 3 分两波 → 3 波，7 任务全部在列。
  // 报告文案已中文化（59df16b6），断言跟「波次 N」而非旧英文 "N waves"。
  assert.match(result.content, /波次 3/)
  for (const id of ['T1', 'T2', 'T3', 'T4', 'T5', 'T6', 'T7']) {
    assert.ok(result.content.includes(id), `任务 ${id} 必须出现在波次结构中`)
  }
  // wave 0 只派 scout（写工依赖它）——派发数不坍缩也不越波。
  assert.equal(captured.length, 1)
  clearPlan(sessionId)
})

test('T5: 编号清单目标（无 files）经 plan_task → team_orchestrate 并行派发多分片', async () => {
  const sessionId = 't5-e2e-numbered'
  clearWaveResults(sessionId)
  consumePlan(sessionId)

  const planTool = createPlanTaskTool({
    getCoordinator: () => ({}) as unknown as DelegationCoordinator,
    getExecutorDeps: () => ({ delegateBatch: async () => run([], 'unused') }),
    getSessionId: () => sessionId,
    writeTodos: () => {},
  })
  const objective = [
    '在 toolkit2/ 目录下创建零依赖工具库，三个相互独立的模块，纯 ESM（.mjs）。',
    '',
    '1. toolkit2/slug.mjs + toolkit2/slug.test.mjs —— slugify(text)。',
    '2. toolkit2/clamp.mjs + toolkit2/clamp.test.mjs —— clamp 与 lerp。',
    '3. toolkit2/dedent.mjs + toolkit2/dedent.test.mjs —— dedent(text)。',
  ].join('\n')
  const planResult = await planTool.execute({
    input: { objective },
    cwd: process.cwd(),
    toolUseId: 'pt-t5-numbered',
    sessionId,
  })
  assert.notEqual(planResult.isError, true)

  let captured: DelegationRequest[] = []
  const teamTool = createTeamOrchestrateTool({
    delegateBatch: async requests => {
      captured = requests
      return run(requests.map(r => mkResult({ workOrderId: r.parentTurnId, status: 'passed' })), 'wave0')
    },
  })
  const teamResult = await teamTool.execute({
    input: { mode: 'standard', objective: `force: ${objective}`, fromWave: 0 },
    cwd: process.cwd(),
    toolUseId: 'tu-t5-numbered',
    sessionId,
  })

  assert.equal(teamResult.isError, false)
  // 修复前的坍缩形状：1 个 monolith patcher、files:[]。修复后：3 个编号分片
  // 文件互不重叠 → 同一波并行派发 3 个写工。
  assert.equal(captured.length, 3, `wave 0 应并行派发 3 个分片，实际 ${captured.length}`)
  clearPlan(sessionId)
})

// ── Phase D: clear error when standard mode has nothing to run ──────────────

test('team_orchestrate reports a clear error when no plan is provided or stored', async () => {
  const sessionId = 'bridge-no-plan'
  clearWaveResults(sessionId)
  consumePlan(sessionId)

  const tool = createTeamOrchestrateTool({ delegateBatch: async () => run([], 'nope') })
  const result = await tool.execute({
    input: { mode: 'standard', objective: 'force: nothing to orchestrate here at all' },
    cwd: process.cwd(),
    toolUseId: 'tu-noplan',
    sessionId,
  })

  assert.equal(result.isError, true)
  assert.match(result.content, /未提供计划，也未找到已存储的计划/)
})

// ── 条件依赖边（收编 #6）跨桥接：plan_task 输出的带边 UnifiedPlan 必须原样
//    到达派发层（DelegationRequest.dependencies 携带 DependencyEdge，team: 前缀）。 ──

test('conditional dependency edges survive the plan → team_orchestrate bridge', async () => {
  const sessionId = 'bridge-edge'
  clearWaveResults(sessionId)
  consumePlan(sessionId)

  storePlan(JSON.stringify({
    version: 1,
    objective: 'conditional edge bridge',
    tasks: [
      { id: 'T1', title: 'scout', objective: 'Explore codebase', profile: 'code_scout', kind: 'code_search', files: [], dependsOn: [], riskTier: 'low' },
      { id: 'T2', title: 'edit', objective: 'Modify src/agent/foo.ts', profile: 'patcher', kind: 'patch_proposal', files: ['src/agent/foo.ts'], dependsOn: [{ dependsOn: 'T1', onFailure: 'skip' }], riskTier: 'low' },
    ],
    source: 'plan_task',
    createdAt: Date.now(),
  }), sessionId)

  // Wave 0: dispatch T1 (scout), report NO results — 空结果使 wave1 不触发
  // 「跨波已满足依赖剥离」（priorResults 为空），T2 的条件边才能原样到达
  // 派发层；T1 passed 会触发剥离，断言会被有意设计遮蔽（见 waveToRequests
  // 的 cross-wave stripping 注释）。
  const toolA = createTeamOrchestrateTool({
    delegateBatch: async () => run([], 'wave0'),
  })
  const r0 = await toolA.execute({
    input: { mode: 'standard', objective: 'force: conditional edge wave 0', fromWave: 0 },
    cwd: process.cwd(),
    toolUseId: 'tu-edge-0',
    sessionId,
  })
  assert.equal(r0.isError, false, '带边计划不得在校验层被拦（RED：validateUnifiedPlan 误报 unknown task）')

  // Wave 1: dispatch T2 — its conditional edge must arrive intact.
  let captured: DelegationRequest[] = []
  const toolB = createTeamOrchestrateTool({
    delegateBatch: async requests => { captured = requests; return run([], 'wave1') },
  })
  const r1 = await toolB.execute({
    input: { mode: 'standard', objective: 'force: conditional edge wave 1', fromWave: 1 },
    cwd: process.cwd(),
    toolUseId: 'tu-edge-1',
    sessionId,
  })
  assert.equal(r1.isError, false)
  const req = captured.find(r => r.parentTurnId.includes('T2'))
  assert.ok(req, `T2 必须到达派发层，实际 captured=${JSON.stringify(captured.map(c => c.parentTurnId))}`)
  assert.deepEqual(req!.dependencies, [{ dependsOn: 'team:T1', onFailure: 'skip' }])
  clearPlan(sessionId)
})

// ── plan-store 跨自动多波生命周期：consumePlan 只读一次（读后即删）/
//    多波执行期间计划保持（re-store 保活）/ 续跑调用仍可再次消费 ─────────────

test('consumePlan reads exactly once: consume 完成后 store 即清理，无双重消费', async () => {
  const sessionId = 'bridge-consume-once'
  clearPlan(sessionId)
  storePlan(twoWavePlan(sessionId), sessionId)

  const first = consumePlan(sessionId)
  assert.ok(first, '第一次 consume 返回已存储计划')
  // 读后即删：consume 完成后 store 中不得残留（否则后续 bare 调用会重复消费）。
  assert.equal(getStoredPlan(sessionId), null, 'consume 完成后即清理（读后删）')
  // 只读一次：再次 consume 拿不到——同一份计划不会被消费两遍。
  assert.equal(consumePlan(sessionId), null, 'consumePlan 只读一次')
  clearPlan(sessionId)
})

test('stored plan survives an auto-advanced multi-wave run and a later call can still consume it', async () => {
  const sessionId = 'bridge-keepalive'
  clearWaveResults(sessionId)
  consumePlan(sessionId)
  storePlan(twoWavePlan(sessionId), sessionId)

  // 自动推进（W3C 默认：不带 fromWave → autoAdvance 缺省为 true）：
  // 一次调用内从 wave 0 推进到末波。每波返回 passed，T2 依赖 T1 已满足，
  // 跨波剥离会去掉 T2 的依赖边，但 T2 本身必须照常派发。
  const wavesSeen: string[][] = []
  const tool = createTeamOrchestrateTool({
    delegateBatch: async requests => {
      wavesSeen.push(requests.map(r => r.parentTurnId))
      return run(requests.map(r => mkResult({ workOrderId: r.parentTurnId, status: 'passed' })), 'wave')
    },
  })
  const r1 = await tool.execute({
    input: { mode: 'standard', objective: 'force: keepalive auto multi-wave' },
    cwd: process.cwd(),
    toolUseId: 'tu-keepalive-1',
    sessionId,
  })
  assert.equal(r1.isError, false)
  // 两波都在单次自动推进内派发：T1 先行，T2 依赖其后。
  assert.equal(wavesSeen.length, 2, `自动推进应跑 2 波，实际 ${wavesSeen.length}`)
  assert.ok(wavesSeen[0]!.some(p => p.includes('T1')), 'wave 0 必须派发 T1')
  assert.ok(wavesSeen[1]!.some(p => p.includes('T2')), 'wave 1 必须派发 T2')

  // 保活：consumePlan 删过一次，但 team_orchestrate 已 re-store——
  // 自动多波执行完成后计划仍在 store，这是人工续跑（第二次 bare 调用）
  // 能再次 consume 的依据。
  assert.ok(getStoredPlan(sessionId), '自动多波执行完成后计划必须仍可读取（re-store 保活）')

  // 续跑：第二次调用（不带 planJson）仍能消费同一份计划并正常派发——
  // 若保活失效会以「未提供计划，也未找到已存储的计划」硬拦（isError=true）。
  let captured2: DelegationRequest[] = []
  const toolB = createTeamOrchestrateTool({
    delegateBatch: async requests => {
      captured2 = requests
      return run(requests.map(r => mkResult({ workOrderId: r.parentTurnId, status: 'passed' })), 'wave')
    },
  })
  const r2 = await toolB.execute({
    input: { mode: 'standard', objective: 'force: keepalive resume', fromWave: 1 },
    cwd: process.cwd(),
    toolUseId: 'tu-keepalive-2',
    sessionId,
  })
  assert.equal(r2.isError, false, '续跑调用必须能再次消费到同一份计划')
  assert.ok(captured2.some(r => r.parentTurnId.includes('T2')), '续跑从 wave 1 派发 T2')
  clearPlan(sessionId)
})
