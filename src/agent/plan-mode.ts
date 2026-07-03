/** Plan Mode — 只读探索→执行的二态控制 */

import { resolve } from 'node:path'

/** Plan Mode 状态（两态：off / planning） */
export type PlanModeState = 'off' | 'planning'

/** Plan Mode 下允许的工具 — 只读探索 + 澄清/委派 + plan 提交/关闭计划 + memory 回忆 */
export const PLAN_MODE_ALLOWED_TOOLS: ReadonlySet<string> = new Set([
  'read_file', 'read_section', 'grep', 'glob', 'repo_map',
  'inspect_project', 'related_tests', 'diff', 'todo',
  'repo_graph', 'web_fetch', 'web_search', 'memory', 'plan',
  'ask_user_question', 'delegate_task', 'delegate_batch',
])

export interface PlanModeCheckContext {
  cwd?: string
  /** write_file / edit_file 目标路径（相对或绝对） */
  targetFilePath?: string
  /** 当前活动计划文件（相对 cwd），仅允许对该路径写入 */
  activePlanFilePath?: string | null
}

export interface PlanModeResult {
  /** 是否允许执行 */
  allowed: boolean
  /** 拒绝原因（allowed=false 时） */
  reason?: string
}

/** 生成新的活动计划草稿路径（相对 cwd） */
export function createActivePlanDraftPath(): string {
  return `.rivet/plans/draft-${Date.now()}.md`
}

function normalizePath(cwd: string, inputPath: string): string {
  return resolve(cwd, inputPath).replace(/\\/g, '/')
}

function pathsMatch(cwd: string, a: string, b: string): boolean {
  return normalizePath(cwd, a) === normalizePath(cwd, b)
}

/** 检查工具是否在 plan-mode 下被允许 */
export function checkPlanMode(
  state: PlanModeState,
  toolName: string,
  ctx?: PlanModeCheckContext,
): PlanModeResult {
  if (state === 'off') return { allowed: true }

  if (
    (toolName === 'write_file' || toolName === 'edit_file')
    && ctx?.cwd
    && ctx.activePlanFilePath
    && ctx.targetFilePath
    && pathsMatch(ctx.cwd, ctx.targetFilePath, ctx.activePlanFilePath)
  ) {
    return { allowed: true }
  }

  if (PLAN_MODE_ALLOWED_TOOLS.has(toolName)) return { allowed: true }

  const planFileHint = ctx?.activePlanFilePath
    ? ` Active plan file (writable): \`${ctx.activePlanFilePath}\`.`
    : ''
  return {
    allowed: false,
    reason:
      `Plan Mode is active — write operations are blocked.${planFileHint} ` +
      'Allowed tools: read, grep, glob, repo_map, inspect_project, web_search, web_fetch, ' +
      'ask_user_question, delegate_task/delegate_batch (code_scout/doc_scout + authority), todo, plan. ' +
      'Use /plan-approve to exit plan mode and allow execution.',
  }
}
