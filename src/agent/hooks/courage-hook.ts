import type { PreTurnRuntimeHook } from '../runtime-hooks.js'
import type { ToolHistoryEntry } from '../../prompt/volatile.js'

export interface CourageHookConfig {
  cooldownTurns?: number
  courageThreshold?: number
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

export function createCourageHook(config: CourageHookConfig = {}): PreTurnRuntimeHook {
  const cooldownTurns = config.cooldownTurns ?? DEFAULT_COOLDOWN_TURNS
  const courageThreshold = config.courageThreshold ?? DEFAULT_COURAGE_THRESHOLD
  let lastTriggeredTurn = -Infinity

  return {
    phase: 'preTurn',
    name: 'courage',
    run(ctx) {
      const turn = ctx.snapshot.turn
      if (turn - lastTriggeredTurn < cooldownTurns) return
      if (!shouldTriggerCourage(ctx.snapshot.recentToolHistory, courageThreshold)) return

      lastTriggeredTurn = turn
      ctx.effects.injectUserMessage(
        '<metacognition>风险信号出现。在下一个工具调用之前，用一句话说出当前方向的最大风险。如果没有风险，说"风险评估：无阻塞风险"。</metacognition>',
      )
    },
  }
}
