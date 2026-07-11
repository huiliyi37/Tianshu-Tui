/**
 * Destructive Gate — 破坏性命令 pre-execution 闸门(会话级状态)。
 *
 * 补 git-clear-after-fail hook 的时机缺口:hook 是 postTool 事后检测,
 * advisory 发出时清场命令已执行完。本闸门在 tool-pipeline 执行前切面
 * (TDD gate 之后、PreToolUse hook 之前)同步拦截。
 *
 * 耦合设计(天枢复核 2026-07-04):失败判据不经 hook 中转——tool-pipeline
 * 本身就是失败检测第一现场(bash 测试命令与 run_tests 两处 trackVerification
 * 调用点)。pipeline 做唯一写者(noteVerification/noteToolExecuted)兼唯一
 * 读者(evaluate),全同步、零跨模块隐式耦合。hook 自己的 failWindow 保留,
 * 判据同源(GIT_CLEAR_RE 来自 destructive-patterns.ts、同窗口语义)但状态独立。
 *
 * 语义:首次拦截、重复放行——同一命令在拦截后再次原样提交视为显式坚持,
 * 放行。避免死锁,保留人/模型的最终决定权(与 TDD gate 的纯阻断不同,
 * 这里拦的是"压力状态下的第一反应",不是"永远不许做")。
 */

import { GIT_CLEAR_RE } from './destructive-patterns.js'

/** 失败后窗口大小(工具调用数)——与 git-clear-after-fail hook 的 WINDOW_SIZE 同语义 */
const WINDOW_SIZE = 3

export type DestructiveGateDecision =
  | { block: false }
  | { block: true; message: string }

export interface DestructiveGateState {
  /** 写入点:pipeline 两处 trackVerification 旁。failed 开窗,passed 关窗。 */
  noteVerification(status: 'passed' | 'failed' | 'blocked'): void
  /** 写入点:每个工具实际执行完成处(被拦截的调用不计数,窗口保持)。 */
  noteToolExecuted(): void
  /** 读取点:bash 执行前。返回 block 时调用方应以 is_error tool_result 短路。 */
  evaluate(toolName: string, input: Record<string, unknown>): DestructiveGateDecision
}

function normalizeCommand(cmd: string): string {
  return cmd.trim().replace(/\s+/g, ' ')
}

/** 安全调用 getVirtueCredit，回调抛异常时返回 undefined（fallback 到无信任轨迹） */
function safeGetVirtueCredit(getter?: () => number): number | undefined {
  try {
    return getter?.()
  } catch {
    return undefined
  }
}

function buildBlockMessage(cmd: string, virtueCredit?: number): string {
  const lines = [
    '⛔ 已拦截(destructive-gate):测试刚失败,你正在执行 git 清场命令。',
    `  命令:${cmd.slice(0, 160)}`,
    '  为什么拦:验证失败后立即 stash/reset/checkout/restore/clean 会丢改动,',
    '  且本仓库多会话共享工作区,可能误伤其他会话的改动。失败根因(测试非隔离、',
    '  共享临时路径、外部改动)未定位前,清场只是把问题藏起来。',
    '  正确路径:先用 read_file/grep 检查失败的测试与相关文件,定位根因。',
    '  如果你确认必须清场:原样重发同一命令即放行(拦截仅一次)。',
  ]
  if (virtueCredit !== undefined && virtueCredit >= 0.7) {
    lines.push(`  本会话美德轨迹良好(信任分 ${virtueCredit.toFixed(2)}),若确认必须清场请原样重发。`)
  }
  return lines.join('\n')
}

export function createDestructiveGateState(options?: { windowSize?: number; getVirtueCredit?: () => number }): DestructiveGateState {
  const windowSize = options?.windowSize ?? WINDOW_SIZE
  const getVirtueCredit = options?.getVirtueCredit
  /** 失败后经过的(实际执行的)工具调用计数;null = 窗口关闭 */
  let toolCallsSinceFail: number | null = null
  /** 已拦截过一次的命令(归一化)——再次提交视为显式坚持,放行 */
  const blockedOnce = new Set<string>()

  return {
    noteVerification(status) {
      if (status === 'failed') {
        toolCallsSinceFail = 0
      } else if (status === 'passed') {
        toolCallsSinceFail = null
      }
      // blocked(验证被环境阻断)不是失败信号,窗口状态不变
    },

    noteToolExecuted() {
      if (toolCallsSinceFail === null) return
      toolCallsSinceFail++
      if (toolCallsSinceFail > windowSize) toolCallsSinceFail = null
    },

    evaluate(toolName, input) {
      if (toolName !== 'bash') return { block: false }
      if (toolCallsSinceFail === null) return { block: false }
      const cmd = typeof input.command === 'string' ? input.command : ''
      if (!GIT_CLEAR_RE.test(cmd)) return { block: false }

      const key = normalizeCommand(cmd)
      if (blockedOnce.has(key)) return { block: false }

      blockedOnce.add(key)
      const credit = safeGetVirtueCredit(getVirtueCredit)
      return { block: true, message: buildBlockMessage(cmd, credit) }
    },
  }
}
