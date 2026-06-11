/**
 * 子代理 progressive 超时曲线 —— 等差数列（公差 60s）。
 *
 * 这是 timeout-ladder 的唯一职责。**不**承载跨层「统一不变式」：
 * SSE idle（client 各自管）/ hardStall（loop.ts turn 层）/ worker budget
 * （work-order dispatch 层）是三个不同抽象层，各自兜底，不在此对齐。
 * worker「卡住」的运行态判定由静默探测（worker-liveness.ts）负责——
 * worker 因「静默」被收，不因「干得久」被收。
 */

/** 默认 worker 预算 —— 远兜底，防死循环，不当日常杀手。 */
export const DEFAULT_WORKER_BUDGET_MS = 180_000

/** 等差 progressive 超时：turn≤1→60s，turn≤4→120s，否则 180s（公差 60s）。
 * @param sessionTurnCount current session turn (0-based). Defaults to mature. */
export function progressiveTimeout(sessionTurnCount?: number): number {
  const turn = sessionTurnCount ?? 10
  if (turn <= 1) return 60_000
  if (turn <= 4) return 120_000
  return 180_000
}
