import type { PreTurnRuntimeHook } from '../runtime-hooks.js'
import type { ToolHistoryEntry } from '../../prompt/volatile.js'

/**
 * 信念宪法迁移 — 从提示注入恢复到宪法级义务语义。
 *
 * 原始信念宪法是构成性规则（constitutive rules）：定义行为合法性边界，
 * 违规时 CVM 拦截并强制纠正。当前 courage-hook 是启发性提示——
 * 只问"你有风险吗？"，模型可以选择回答"没有"然后继续错。
 *
 * 本模块接受 sycophancy trap 作为可选输入：当 trap 检测到连续投降 +
 * confidence 递减模式时，courage-hook 切换到宪法模式——绕过冷却、
 * 注入带"必须"义务语义的修正指令，恢复信念宪法的核心能力：
 * 不是在提示层面建议，是在运行时结构中施加义务。
 *
 * 不依赖 sycophancy trap 的类型导入（避免循环依赖），
 * 通过最小的 { shouldInjectChallenge() } 接口消费其累积状态。
 */

export interface CourageHookConfig {
  cooldownTurns?: number
  courageThreshold?: number
  /**
   * Sycophancy trap 累积状态查询 — 最小接口，避免循环依赖。
   * 当 trap 检测到连续投降模式时，courage-hook 切换到宪法模式：
   * 绕过冷却、注入"必须"语义的义务性指令。
   */
  sycophancyTrap?: {
    shouldInjectChallenge(): boolean
  }
}

const DEFAULT_COOLDOWN_TURNS = 5
const DEFAULT_COURAGE_THRESHOLD = 0.5
const RISK_SIGNALS = ['error', 'fail', 'failed', 'warning', 'type error', 'not found', 'deprecated']

type CourageToolHistoryEntry = Pick<ToolHistoryEntry, 'tool' | 'target' | 'status'>

function includesRiskSignal(entry: CourageToolHistoryEntry): boolean {
  const haystack = `${entry.tool} ${entry.target}`.toLowerCase()
  return RISK_SIGNALS.some(signal => haystack.includes(signal))
}

export function shouldTriggerCourage(
  toolHistory: CourageToolHistoryEntry[],
  threshold: number = DEFAULT_COURAGE_THRESHOLD,
): boolean {
  if (toolHistory.length === 0) return false
  const recent = toolHistory.slice(-3)
  const riskCount = recent.filter(entry => entry.status === 'failed' || includesRiskSignal(entry)).length
  return riskCount / Math.max(recent.length, 1) >= threshold
}

const RISK_HINT =
  '<天权-感知 type="risk">风险信号出现。在下一个工具调用之前，用一句话说出当前方向的最大风险。如果没有风险，说"风险评估：无阻塞风险"。天权胶囊（docs/seed-capsule-tianquan.md）有称量方法论可供参考。</天权-感知>'

/**
 * 宪法级义务提醒 — 不同于风险信号（"你觉得有风险吗？"），
 * 这条消息是一个不可选择的行为义务：在下一个工具调用之前
 * 必须说出验证计划和方向隐患。"必须"意味着不履行 = 违规，
 * 不可用"无阻塞风险"回应。
 *
 * 措辞哲学继承 sycophancy-trap.ts 的设计原则：
 * - 不指控"你在讨好"
 * - 不指令"去质疑用户"
 * - 只要求"说出你打算怎么验证"
 */
const CONSTITUTIONAL_HINT =
  '<天权-感知 type="constitutional">信念宪法：连续多轮无验证推进，信心单调下降。这不是建议——在下一个工具调用之前，你必须用一句话说明打算验证什么、怎么验证。如果当前方向有隐患，必须说出来。不履行意味着继续推进不被允许。天权胶囊（docs/seed-capsule-tianquan.md）有称量方法论可供参考。</天权-感知>'

export function createCourageHook(config: CourageHookConfig = {}): PreTurnRuntimeHook {
  const cooldownTurns = config.cooldownTurns ?? DEFAULT_COOLDOWN_TURNS
  const courageThreshold = config.courageThreshold ?? DEFAULT_COURAGE_THRESHOLD
  const sycophancyTrap = config.sycophancyTrap
  let lastTriggeredTurn = -Infinity

  return {
    phase: 'preTurn',
    name: 'courage',
    run(ctx) {
      const turn = ctx.snapshot.turn
      // 宪法级：sycophancy trap 触发 → 绕过冷却、强制注入义务性指令
      const constitutional = sycophancyTrap?.shouldInjectChallenge() ?? false
      if (!constitutional && turn - lastTriggeredTurn < cooldownTurns) return
      if (!constitutional && !shouldTriggerCourage(ctx.snapshot.recentToolHistory, courageThreshold)) return

      lastTriggeredTurn = turn
      ctx.effects.injectUserMessage(constitutional ? CONSTITUTIONAL_HINT : RISK_HINT)
    },
  }
}
