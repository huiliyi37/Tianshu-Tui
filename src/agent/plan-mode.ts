/** Plan Mode — 只读探索→执行的二态控制 */

import { resolve } from 'node:path'
import type { ApprovalMode } from './loop-types.js'

/** Plan Mode 状态（两态：off / planning） */
export type PlanModeState = 'off' | 'planning'

/** Shift+Tab plan 叠层：进入/退出时的 stash 决策（不兼审批环） */
export interface ShiftTabPlanToggleState {
  isPlanning: boolean
  currentApprovalMode: ApprovalMode
  /** 进入 plan 前记住的审批模式；未叠层时为 null */
  approvalModeBeforePlan: ApprovalMode | null
}

export type ShiftTabPlanToggleResult =
  | {
      action: 'enter'
      /** 进入时 stash，供退出恢复 */
      stashMode: ApprovalMode
      /** 进入不改 approval */
      restoreMode: null
    }
  | {
      action: 'exit'
      stashMode: null
      /** 退出后恢复的审批模式 */
      restoreMode: ApprovalMode
    }

/**
 * Shift+Tab = 纯 Plan Mode 叠层开关。
 * 进入：记住当前审批模式，不改 approval；退出：原样恢复 stash。
 */
export function nextShiftTabPlanToggle(state: ShiftTabPlanToggleState): ShiftTabPlanToggleResult {
  if (state.isPlanning) {
    return {
      action: 'exit',
      stashMode: null,
      restoreMode: state.approvalModeBeforePlan ?? 'auto-safe',
    }
  }
  return {
    action: 'enter',
    stashMode: state.currentApprovalMode,
    restoreMode: null,
  }
}

/** 审批模式短标签（CLI 状态行 / Shift+Tab 提示） */
export function approvalModeShortLabel(mode: ApprovalMode): string {
  switch (mode) {
    case 'dangerously-skip-permissions':
      return 'yolo'
    case 'auto-accept':
      return 'auto-accept'
    case 'manual':
      return 'manual'
    case 'auto-safe':
    default:
      return 'auto-safe'
  }
}

/** Shift+Tab 进入/退出 plan 后的状态提示 */
export function shiftTabPlanToggleHint(
  action: 'enter' | 'exit',
  underlyingMode: ApprovalMode,
): string {
  const label = approvalModeShortLabel(underlyingMode)
  if (action === 'enter') {
    return `⏵ plan mode — 写入已锁定（底层仍为 ${label}）`
  }
  switch (underlyingMode) {
    case 'dangerously-skip-permissions':
      return '⏵ yolo mode — all tools auto-approved (use with caution)'
    case 'auto-accept':
      return '⏵ auto-accept mode — edits auto-approved'
    case 'manual':
      return '⏵ manual mode — approval required for all tools'
    case 'auto-safe':
    default:
      return '⏵ auto-safe mode — bash requires approval'
  }
}

/** Plan Mode 下允许的工具 — 只读探索 + 澄清/委派 + plan 提交/关闭计划 + memory 回忆。
 *  run_tests 在列：瑶光反证要求计划期就复现关键声称（跑失败测试拿 RED 证据），
 *  测试执行不修改源码，且 VSW 可用时跑在快照工作树里。bash 仍然被拒。 */
export const PLAN_MODE_ALLOWED_TOOLS: ReadonlySet<string> = new Set([
  'read_file', 'read_section', 'grep', 'glob', 'repo_map',
  'inspect_project', 'related_tests', 'diff', 'todo',
  'repo_graph', 'web_fetch', 'web_search', 'memory', 'plan',
  'ask_user_question', 'delegate_task', 'delegate_batch',
  'run_tests',
])

export interface PlanModeCheckContext {
  cwd?: string
  /** write_file / edit_file 目标路径（相对或绝对） */
  targetFilePath?: string
  /** 当前活动计划文件（相对 cwd），仅允许对该路径写入 */
  activePlanFilePath?: string | null
  /** 委派工具（delegate_task/delegate_batch）请求的 profile 是否超出规划模式安全集。
   *  由调用方（tool-pipeline）预先用 profile registry 算好传入（profileIsPlanModeSafe
   *  的否定），保持本函数纯粹可测。规划模式放行只读侦察 profile 以及仅额外持有
   *  run_tests 的验证型 profile（adversarial_verifier 等——瑶光反证需要计划期复现）；
   *  任何持有真实写/执行工具（bash/edit/git…）的 profile 一律拒。 */
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
 * 归一路径用于相等比较：反斜杠→斜杠；盘符形路径（Windows）整体小写。
 * NTFS 大小写不敏感，且盘符大小写在真实环境里不稳定——VSCode/Git Bash 常给
 * 小写盘符（`c:\proj`）而 `process.cwd()` 给大写（`C:\proj`）。逐字节比较会
 * 误拒活动计划文件的写入 → plan mode 下草稿永远为空（桌面「起草中」断流）。
 * Exported for direct unit testing（盘符分支在 POSIX 跑不到 resolve 路径）。
 */
export function canonicalizePathForCompare(p: string): string {
  const s = p.replace(/\\/g, '/')
  return /^[a-zA-Z]:\//.test(s) ? s.toLowerCase() : s
}

function pathsMatch(cwd: string, a: string, b: string): boolean {
  return canonicalizePathForCompare(resolve(cwd, a)) === canonicalizePathForCompare(resolve(cwd, b))
}

/**
 * Short tool-result receipt when write/edit hits the active plan draft —
 * CLI users often misread silence as "didn't land". Only tool result text
 * (never frozen prompt).
 */
export function formatActivePlanDraftReceipt(
  cwd: string,
  targetFilePath: string,
  activePlanFilePath: string | null | undefined,
  charCount: number,
): string | null {
  if (!activePlanFilePath) return null
  if (!pathsMatch(cwd, targetFilePath, activePlanFilePath)) return null
  return `已写入活动计划文件 \`${activePlanFilePath}\`（${charCount} chars）`
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
        'Plan Mode: only read-only scout profiles (code_scout/doc_scout) and test-only verifiers ' +
        '(adversarial_verifier — for 瑶光反证 reproduction) may be delegated; ' +
        'write/execute profiles (e.g. patcher) are blocked until the plan is approved. ' +
        'Re-run delegation with one of those profiles, or /plan-approve first.',
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
      'ask_user_question, run_tests (瑶光反证 reproduction), ' +
      'delegate_task/delegate_batch (code_scout/doc_scout/adversarial_verifier + authority), todo, plan. ' +
      'Use /plan-approve to exit plan mode and allow execution.',
  }
}
