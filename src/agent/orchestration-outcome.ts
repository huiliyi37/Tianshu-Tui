// ⚠ 本文件禁止 import 重型模块：它是 tools/types.ts 的引用闭包成员
//（ToolResult.orchestration 字段类型），而 tools/types.ts 经 server 类型链被
// desktop tsc 引用——import team-orchestrator/plan-executor 会把整个 agent 域
// 拖进桌面端编译图（2026-08-02 实证：桌面 build 因此暴露 75 处跨域报错）。
// 构造器参数用下方结构切面：调用方传真实 TeamRunSummary / PlanExecutorRun，
// TS 结构子类型直接兼容，运行时与类型语义均零变化。

/** WorkerResult.status 的字面量副本（work-order.ts:241 的 zod enum）。
 *  这里不 import 而是抄一份：import 会把 agent 域拖进桌面 tsc 编译图（见文件头）。
 *  但也**不能**退化成 `string`——`=== 'passed'` 是本模块唯一的判定，宽成 string 就
 *  等于把编译期保护换掉，而 ToolResult.orchestration 选窄类型而非 unknown 的全部
 *  理由就是「字段漂移要在编译期暴露」。枚举改名时这里会红，那正是想要的。 */
type WorkerStatus = 'passed' | 'failed' | 'blocked' | 'escalated'

/** TeamRunSummary 的结构切面（buildTeamOutcome 实际读取的字段）。 */
export interface TeamOutcomeSummarySlice {
  dispatched: number
  waves: readonly unknown[]
  run?: { results?: ReadonlyArray<{ status: WorkerStatus }> }
}

/** PlanExecutorRun 的门禁/裁决切面（gate 实际对象多带 wave 字段，结构超集兼容）。 */
export interface TeamOutcomeRunSlice {
  gate?: { passed: boolean; failures: string[] }
  reviewVerdict?: string
}

/** 编排工具回给上游编排器（starflow）的结构化事实。
 *  与 ToolResult.errorKind 同一解法：门禁读字段，不读 formatter 散文。
 *  字段只加有消费者的——无 reader 的字段是死写，见
 *  docs/design/2026-08-01-orchestration-readside-wiring.md。 */
export interface TeamOrchestrationOutcome {
  kind: 'team'
  /** 本次调用派发的 worker 数；0 = 计划无可执行波次。 */
  dispatched: number
  /** 本次派发的波次序号（= 入参 fromWave）。 */
  wave: number
  /** 计划总波次；wave + 1 < totalWaves 表示还有下一波。 */
  totalWaves: number
  /** 本波 worker 终态计数；total=0 表示未产出结果（未派发/预览）。 */
  workers: { total: number; passed: number }
  /** 波间硬门禁结果——非末波且已评估才有值（plan-executor.ts:466）。
   *  只挑 passed/failures：`run.gate` 还带一个 `wave`，与顶层 `wave` 同义，
   *  整包透传就是又一个 StarflowPhaseRecord.at（写了没人读）。 */
  waveGate?: { passed: boolean; failures: string[] }
  /** review gate 裁决枚举词（'verified' / 'rejected' / …）。 */
  reviewVerdict?: string
}

/** council 工具（council_convene）回给上游编排器的结构化事实。
 *  承载 gate 需要的最小事实：评审是否实际执行。isError:false 的禁用/未派发
 *  路径（council-convene.ts:137）散文是唯一失败信号——disabled 布尔是它的
 *  结构化镜像，councilGate 优先读它、content.includes 降级兜底。 */
export interface CouncilOrchestrationOutcome {
  kind: 'council'
  /** 议事会是否执行：true = 禁用（COUNCIL=0）或未派发任何席位；
   *  false = 评审已实际执行（产出密封契约或否决）。 */
  disabled: boolean
}

/** galaxy 工具回给上游编排器的结构化事实。
 *  GALAXY_FAILED_RE / GALAXY_DIM_LINE_RE 逐维度解析自家渲染行的结构化镜像：
 *  写侧在 coordinator run.results 上已有终态计数，出站挂 total/passed/failed，
 *  galaxyGate 优先读它、正则降级兜底。 */
export interface GalaxyOrchestrationOutcome {
  kind: 'galaxy'
  /** 派发维度终态（含 autoReview 追加的审查维度）；failed 是未通过维度的
   *  报告行标签（dimension 名，与 formatter 渲染行同源）。 */
  dimensions: { total: number; passed: number; failed: string[] }
}

export type OrchestrationOutcome =
  | TeamOrchestrationOutcome
  | CouncilOrchestrationOutcome
  | GalaxyOrchestrationOutcome

export function buildTeamOutcome(
  summary: TeamOutcomeSummarySlice,
  fromWave: number,
  run: TeamOutcomeRunSlice,
): TeamOrchestrationOutcome {
  const results = summary.run?.results ?? []
  return {
    kind: 'team',
    dispatched: summary.dispatched,
    wave: fromWave,
    totalWaves: summary.waves.length,
    workers: { total: results.length, passed: results.filter(r => r.status === 'passed').length },
    ...(run.gate ? { waveGate: { passed: run.gate.passed, failures: run.gate.failures } } : {}),
    ...(run.reviewVerdict ? { reviewVerdict: run.reviewVerdict } : {}),
  }
}
