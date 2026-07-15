import type { AfterPerceptionRuntimeHook, RuntimeHookContext } from '../runtime-hooks.js'
import type { AdvisoryBus } from '../advisory-bus.js'

/**
 * Context Pressure Hook — afterPerception advisory when context window
 * fill ratio exceeds a warning threshold.
 *
 * Suggests offloading remaining work to a new session before hitting the
 * 86% split threshold (CompactBoundaryCoordinator.trySessionSplit).
 *
 * Tier: key='context-pressure', category='cerebellar', priority=0.5.
 * One advisory per turn max. Suppressed when ratio drops back below threshold.
 */

export interface ContextPressureHookDeps {
  getEstimatedTokens: () => number
  getContextWindow: () => number
  advisoryBus: Pick<AdvisoryBus, 'submit'>
}

/** Ratio above which the advisory fires. Below 86% split but high enough
 *  to give the agent time to wrap up. */
const PRESSURE_WARN_RATIO = 0.7
/** Second escalation threshold — aligned with the 86% session-split boundary. */
const PRESSURE_SPLIT_RATIO = 0.86
/** Hysteresis: a threshold re-arms only after the ratio drops this far below it. */
const REARM_HYSTERESIS = 0.05

export function createContextPressureHook(deps: ContextPressureHookDeps): AfterPerceptionRuntimeHook {
  // W2-B3 阈值跨越语义：fill% 每轮 appendix 被明确否决——同一阈值只在
  // 「首次跨越」时产生一条提醒，数字只出现在跨越那一轮；持续高于阈值不重复
  //（旧行为每轮带变化百分比重发，等价于每轮翻转 advisory appendix 字节）。
  // 比率回落到阈值-滞回以下后重新武装，再次跨越可再报。
  const firedThresholds = new Set<number>()

  return {
    phase: 'afterPerception',
    name: 'context-pressure',
    run(ctx: RuntimeHookContext): void {
      void ctx
      const estimated = deps.getEstimatedTokens()
      const window = deps.getContextWindow()
      if (window <= 0 || estimated <= 0) return

      const ratio = estimated / window

      // Re-arm thresholds the ratio has dropped safely below (compact/split).
      for (const t of firedThresholds) {
        if (ratio < t - REARM_HYSTERESIS) firedThresholds.delete(t)
      }

      // Highest newly-crossed threshold wins this turn.
      const crossed = [PRESSURE_SPLIT_RATIO, PRESSURE_WARN_RATIO]
        .find(t => ratio >= t && !firedThresholds.has(t))
      if (crossed === undefined) return

      firedThresholds.add(crossed)
      // Crossing 86% implies 70% is also spent — don't fire a stale lower tier later.
      if (crossed === PRESSURE_SPLIT_RATIO) firedThresholds.add(PRESSURE_WARN_RATIO)

      const escalation = crossed === PRESSURE_SPLIT_RATIO
        ? '已越过 86% 会话分拆线，compact-boundary 随时可能分拆会话——立即收束当前子任务。'
        : '接近上限时 compact-boundary 会自动分拆会话，但建议你主动收束当前子任务、把后续工作留给新会话。'
      deps.advisoryBus.submit({
        key: 'context-pressure',
        priority: crossed === PRESSURE_SPLIT_RATIO ? 0.6 : 0.5,
        category: 'cerebellar',
        // W3-C2 分类审计：状态解释类信号（“窗口快满了”），采纳无唯一可观察
        // 动作（收束子任务不是工具签名）→ informational tier、无 expect。
        // 硬填“任意工具出现”会制造伪采纳率，禁止。
        tier: 'informational',
        content: `上下文窗口使用率已跨越 ${Math.round(crossed * 100)}% 阈值（当前 ${Math.round(ratio * 100)}%，${estimated}/${window} tokens）。${escalation}`,
        ttl: 1,
      })
    },
  }
}
