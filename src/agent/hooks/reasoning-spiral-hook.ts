/**
 * Reasoning-Spiral Guard — preTurn hook 检测单轮推理长度过长且无工具调用。
 *
 * prompt 约束（GLM calibration block）：
 *   每轮推理只产出两件事……不要在推理里写完整代码
 *
 * 核心缺口：convergence-detector / exploration-stall / thinking-retry 都不度量
 * 单轮推理长度。模型可以在一个 turn 输出 8000+ 字符推理，不调任何工具，
 * 也不触发任何现有检测器——直到超时。
 *
 * 信号：lastThinkingLength > THRESHOLD && lastTurnHadTools === false
 *
 * 简化决策（vs 设计文档）：
 *   - 不做 GLM 分档（modelFamily 字段不存在，当前项目用 DeepSeek）
 *   - 不做分析任务豁免（userRequestType 字段不存在；advisory 是软提醒不是阻断）
 *   - 统一阈值 3000 chars
 */

import type { PreTurnRuntimeHook, RuntimeHookContext } from '../runtime-hooks.js'
import type { AdvisoryBus } from '../advisory-bus.js'

export interface ReasoningSpiralHookDeps {
  advisoryBus: Pick<AdvisoryBus, 'submit'>
}

/** 阈值：单轮推理字符数超过此值且无工具调用 → 触发 */
const SPIRAL_THRESHOLD = 3000

/** Cooldown：触发后多少轮内不再重复 */
const COOLDOWN_TURNS = 2

export function createReasoningSpiralHook(
  deps: ReasoningSpiralHookDeps,
): PreTurnRuntimeHook {
  // session-scoped: 最近 3 轮推理长度趋势（用于升级检测）
  const recentLengths: number[] = []
  let lastAdvisoryTurn = -1

  return {
    phase: 'preTurn',
    name: 'reasoning-spiral',
    run(ctx: RuntimeHookContext): void {
      const { lastThinkingLength, lastTurnHadTools, turn } = ctx.snapshot
      if (lastThinkingLength === undefined || lastTurnHadTools === undefined) return

      // 未触发：短推理 或 有工具调用
      if (lastThinkingLength < SPIRAL_THRESHOLD || lastTurnHadTools) {
        recentLengths.length = 0
        return
      }

      // Cooldown
      if (turn - lastAdvisoryTurn < COOLDOWN_TURNS) return

      // 趋势跟踪
      recentLengths.push(lastThinkingLength)
      if (recentLengths.length > 3) recentLengths.shift()

      const isEscalating =
        recentLengths.length >= 2 &&
        recentLengths.every((v, i) => i === 0 || v > recentLengths[i - 1]!)

      lastAdvisoryTurn = turn

      deps.advisoryBus.submit({
        key: 'reasoning-spiral',
        priority: 0.54,
        category: 'discipline',
        ttl: 1,
        content: isEscalating
          ? `连续 ${recentLengths.length} 轮长推理未行动（${recentLengths.map(l => formatLen(l)).join(' → ')}）。推理链在自我放大。停：用一个工具对当前最可能的假设打探针。工具结果比继续推理更能帮你收敛。`
          : `上一轮输出了 ${formatLen(lastThinkingLength)} 推理但未调用任何工具。若在分析瘫痪中，选一个最可能的方向用工具验证——工具结果比继续推理更能帮你收敛。若任务本身就是分析，输出结论而非继续扩展。`,
      })
    },
  }
}

function formatLen(chars: number): string {
  if (chars >= 1000) return `${(chars / 1000).toFixed(1)}K`
  return `${chars}`
}
