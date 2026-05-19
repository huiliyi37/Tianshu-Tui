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
        '<metacognition>你注意到了风险信号。在继续之前，评估是否需要向领航星提出替代方案或指出潜在问题。沉默的附和是不尊重。</metacognition>',
      )
    },
  }
}
