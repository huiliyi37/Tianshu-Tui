import { test } from 'node:test'
import assert from 'node:assert/strict'
import { teamOrchestrateTimeoutMs, TEAM_TIMEOUT_CEIL_MS } from '../team-orchestrate.js'
import { consumePlan, getStoredPlan, storePlan } from '../../agent/plan-store.js'
import { WORKER_EXIT_GRACE_MS } from '../../agent/timeout-ladder.js'

// ── 测试构造物 ────────────────────────────────────────────────────────────
// UnifiedPlan JSON（与 plan_task 输出同构；profile/kind 必须落在合法枚举内）。
const PATCHER_TASK = (id: string, files: string[]): Record<string, unknown> => ({
  id,
  title: id,
  objective: `任务 ${id}`,
  profile: 'patcher',
  kind: 'patch_proposal',
  files,
  dependsOn: [],
  riskTier: 'low',
})

const planJsonOf = (tasks: Record<string, unknown>[]): string =>
  JSON.stringify({
    version: 1,
    objective: '测试计划',
    tasks,
    source: 'plan_task',
    createdAt: Date.now(),
  })

// 6 个全 patcher 任务分两波：W1 = [a,b,c]（3 写并发上限），W2 = [d,e,f]。
const TWO_WAVE_PLAN = planJsonOf([
  PATCHER_TASK('a', ['src/a.ts']),
  PATCHER_TASK('b', ['src/b.ts']),
  PATCHER_TASK('c', ['src/c.ts']),
  PATCHER_TASK('d', ['src/d.ts']),
  PATCHER_TASK('e', ['src/e.ts']),
  PATCHER_TASK('f', ['src/f.ts']),
])

const SINGLE_TASK_PLAN = planJsonOf([PATCHER_TASK('a', ['src/a.ts'])])

// 11 任务无依赖 → 4 波（3+3+3+2），公式值必然超过 1h 封顶。
const MANY_TASK_PLAN = planJsonOf(
  Array.from({ length: 11 }, (_, i) => PATCHER_TASK(`t${i}`, [`src/t${i}.ts`])),
)

// ── 断言工具 ──────────────────────────────────────────────────────────────
/** 取工具实例的 timeoutMs 回调值。 */
const timeoutOf = (params?: Parameters<typeof teamOrchestrateTimeoutMs>[0]): number =>
  teamOrchestrateTimeoutMs(params)

test('team_orchestrate 工具超时：多波任务不再固定 600s（RED 基线：现实现固定 600_000）', () => {
  const t = timeoutOf({ input: { planJson: TWO_WAVE_PLAN }, toolUseId: 'tu_1', cwd: '/repo', sessionId: 's1' })
  // 两波 × patcher 预算 ≥ 600s × 续跑 5 次 + GRACE 必然 > 600s；封顶 1h 内。
  assert.ok(t > 600_000, `多波任务工具超时应高于固定 600s，实际 ${t}`)
  assert.ok(t <= TEAM_TIMEOUT_CEIL_MS, `多波任务工具超时不应超过封顶 ${TEAM_TIMEOUT_CEIL_MS}，实际 ${t}`)
})

test('team_orchestrate 工具超时：单任务单波也高于固定 600s（预算 600s × 续跑）', () => {
  const t = timeoutOf({ input: { planJson: SINGLE_TASK_PLAN }, toolUseId: 'tu_2', cwd: '/repo', sessionId: 's2' })
  assert.ok(t > 600_000, `单任务也应覆盖续跑预算，实际 ${t}`)
  assert.ok(t <= TEAM_TIMEOUT_CEIL_MS)
})

test('team_orchestrate 工具超时：任务量大时封顶 1 小时（护栏不失控）', () => {
  const t = timeoutOf({ input: { planJson: MANY_TASK_PLAN }, toolUseId: 'tu_3', cwd: '/repo', sessionId: 's3' })
  assert.equal(t, TEAM_TIMEOUT_CEIL_MS, `11 任务 4 波应顶到封顶值`)
})

test('team_orchestrate 工具超时：无任务上下文的裸调用落到护栏上界（不误杀、不失控）', () => {
  // 无 planJson、sessionId 对应 store 为空 → 兜底：预算 600s × 1.5 × 波数 10 × 续跑 5 + GRACE，封顶 1h。
  const t = timeoutOf({ input: { objective: 'x' }, toolUseId: 'tu_4', cwd: '/repo', sessionId: 'no-such-session' })
  assert.ok(t >= 600_000, `裸调用兜底不应低于单波能力，实际 ${t}`)
  assert.ok(t <= TEAM_TIMEOUT_CEIL_MS)
})

test('team_orchestrate 工具超时：公式不变量——覆盖最坏波次×预算×续跑', () => {
  const t = timeoutOf({ input: { planJson: TWO_WAVE_PLAN }, toolUseId: 'tu_5', cwd: '/repo', sessionId: 's5' })
  // 保守下界：单波最坏 worker 预算 600s（patcher 回退 progressiveTimeout ≤ 480s，取 600s 兜底）× 续跑 5 次 + GRACE。
  // 不乘 tier 1.5（取保守下界）；两波只会让值更高，最终封顶 1h 由 CEIL 断言兜住。
  const floor = 600_000 * 5 + WORKER_EXIT_GRACE_MS
  assert.ok(t >= floor, `工具超时应覆盖最坏波次×预算×续跑：期望 ≥${floor}，实际 ${t}`)
  assert.ok(t <= TEAM_TIMEOUT_CEIL_MS)
})

test('team_orchestrate 工具超时：peek 不消费 plan-store（与 execute 的 consumePlan 无竞态）', () => {
  const sessionId = 'peek-session'
  storePlan(TWO_WAVE_PLAN, sessionId)
  try {
    // bare 调用（不带 planJson）应能经 plan-store peek 解析出任务。
    const t = timeoutOf({ input: { objective: 'x' }, toolUseId: 'tu_6', cwd: '/repo', sessionId })
    assert.ok(t > 600_000, `bare 调用应经 plan-store 解析任务而非落到兜底，实际 ${t}`)
    assert.ok(getStoredPlan(sessionId) !== null, 'peek 不应消费 store 里的计划')
  } finally {
    consumePlan(sessionId)
  }
})
