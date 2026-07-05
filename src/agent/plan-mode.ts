/** Plan Mode — 只读探索→执行的二态控制 */

import { resolve } from 'node:path'

/** Plan Mode 状态（两态：off / planning） */
export type PlanModeState = 'off' | 'planning'

/**
 * Plan-mode injection cadence variant (kimi-code borrow). Controls how heavy the
 * per-turn `<plan-mode>` reminder is — the full spec on entry / every N turns,
 * a sparse one-liner in between, or a short "resuming" header on reentry.
 * Rendering lives in prompt/volatile.ts; the loop computes which variant to emit.
 */
export type PlanInjectionVariant = 'full' | 'sparse' | 'reentry'

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
  /** 委派工具（delegate_task/delegate_batch）请求的 profile 是否具备写/执行能力。
   *  由调用方（tool-pipeline）预先用 profile registry 算好传入，保持本函数纯粹可测。
   *  规划模式只放行只读侦察 profile —— 任何会写文件/执行命令的 profile 一律拒。 */
  delegatesWriteCapableProfile?: boolean
}

/** 委派类工具 —— 规划模式下仅允许其调度只读侦察 worker。 */
const DELEGATE_TOOLS: ReadonlySet<string> = new Set(['delegate_task', 'delegate_batch'])

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

/**
 * Pure cadence formula for the per-turn plan-mode reminder (kimi-code borrow):
 * full spec on entry (or reentry header on resume) and every `refreshEvery`
 * turns, sparse in between. Extracted so the loop's stateful path stays a thin
 * wrapper and the cadence is unit-testable without booting an AgentLoop.
 */
export function planInjectionVariantFor(input: {
  turnsSinceEnter: number
  reentry: boolean
  refreshEvery: number
}): PlanInjectionVariant {
  const { turnsSinceEnter, reentry, refreshEvery } = input
  if (reentry && turnsSinceEnter <= 0) return 'reentry'
  if (turnsSinceEnter <= 0 || turnsSinceEnter % refreshEvery === 0) return 'full'
  return 'sparse'
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

  // Hard-block write/execute-capable delegation — the prompt says "禁止 patcher"
  // but that is advisory; enforce it so a plan-mode session can never dispatch a
  // worker that writes code or runs state-changing commands before approval.
  if (DELEGATE_TOOLS.has(toolName) && ctx?.delegatesWriteCapableProfile) {
    return {
      allowed: false,
      reason:
        'Plan Mode: only read-only scout profiles (code_scout/doc_scout) may be delegated; ' +
        'write/execute profiles (e.g. patcher) are blocked until the plan is approved. ' +
        'Re-run delegation with profile=code_scout/doc_scout, or /plan-approve first.',
    }
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
