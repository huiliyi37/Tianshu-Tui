/** Plan Mode — 只读探索→执行的二态控制 */

/** Plan Mode 状态（两态：off / planning） */
export type PlanModeState = 'off' | 'planning'

/** Plan Mode 下允许的工具 — 只读探索 + plan 提交/关闭计划 + memory 回忆 */
export const PLAN_MODE_ALLOWED_TOOLS: ReadonlySet<string> = new Set([
  'read_file', 'read_section', 'grep', 'glob', 'repo_map',
  'inspect_project', 'related_tests', 'diff', 'todo',
  'repo_graph', 'web_fetch', 'web_search', 'memory', 'plan',
])

export interface PlanModeResult {
  /** 是否允许执行 */
  allowed: boolean
  /** 拒绝原因（allowed=false 时） */
  reason?: string
}

/** 检查工具是否在 plan-mode 下被允许 */
export function checkPlanMode(
  state: PlanModeState,
  toolName: string,
): PlanModeResult {
  if (state === 'off') return { allowed: true }
  // state === 'planning'
  if (PLAN_MODE_ALLOWED_TOOLS.has(toolName)) return { allowed: true }
  return {
    allowed: false,
    reason: `Plan Mode is active — write operations are blocked. Allowed tools: read, grep, glob, repo_map, inspect_project, todo, plan. Use /plan-approve to exit plan mode and allow execution.`,
  }
}
