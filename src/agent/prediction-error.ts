import type { VigorState } from './vigor.js'
import type { CognitiveSeason } from './cognitive-season.js'
import type { Sensorium } from './sensorium.js'

export type InterventionLevel = 'none' | 'hint' | 'gate' | 'escalate'

export interface PredictionAccumulator {
  windowSize: number
  predictions: boolean[] // true = correct, false = error
  consecutiveCorrect: number
}

export function createPredictionAccumulator(windowSize = 10): PredictionAccumulator {
  return { windowSize, predictions: [], consecutiveCorrect: 0 }
}

export function resetAccumulator(acc: PredictionAccumulator): PredictionAccumulator {
  return { ...acc, predictions: [], consecutiveCorrect: 0 }
}

export function recordPrediction(
  acc: PredictionAccumulator,
  correct: boolean,
): PredictionAccumulator {
  const nextPredictions = [...acc.predictions, correct].slice(-acc.windowSize)
  const nextConsecutiveCorrect = correct ? acc.consecutiveCorrect + 1 : 0
  return { ...acc, predictions: nextPredictions, consecutiveCorrect: nextConsecutiveCorrect }
}

export function getErrorRate(acc: PredictionAccumulator): number {
  if (acc.predictions.length < 3) return 0
  const errors = acc.predictions.filter(p => !p).length
  return errors / acc.predictions.length
}

export function getInterventionLevel(acc: PredictionAccumulator): InterventionLevel {
  if (acc.predictions.length < 3) return 'none'
  const rate = getErrorRate(acc)
  if (rate >= 0.8) return 'escalate'
  if (rate >= 0.6) return 'gate'
  if (rate >= 0.4) return 'hint'
  return 'none'
}

export function shouldTippingPointReset(acc: PredictionAccumulator): boolean {
  return acc.consecutiveCorrect >= 3
}


// ─── Expected Free Energy (EFE) — Active Inference ─────────────────

export interface EFEComponents {
  /** 信息增益预期：减少不确定性的价值 */
  epistemicValue: number
  /** 目标推进预期：向目标前进的价值 */
  pragmaticValue: number
  /** 探索奖励：缓解 stagnation 的新颖性 bonus */
  noveltyBonus: number
  /** 置信度加权：precision = f(vigor)，高 precision → exploitation */
  precision: number
}

function clamp(value: number, min = 0, max = 1): number {
  return Math.max(min, Math.min(max, value))
}

/**
 * 计算 Expected Free Energy 组件。
 *
 * 将 PredictionAccumulator、CognitiveSeason、VigorState、Sensorium
 * 映射到 Active Inference 框架的 EFE 四元组。
 *
 * 空状态降级：首次运行时参数可为 null/undefined，返回中性值。
 */
export function computeEFE(
  acc: PredictionAccumulator,
  season: CognitiveSeason | null,
  vigor: VigorState | null,
  sensorium?: Sensorium | null,
): EFEComponents {
  const confidence = sensorium?.confidence ?? 0.5
  const freshness = sensorium?.freshness ?? 0.5
  const vigorEnergy = vigor?.vigor ?? 0.5
  const curiosity = vigor?.curiosity ?? 0.3

  // ── Epistemic Value: 信息增益预期 ──
  // 低 confidence → 高 epistemic（需要探索减少不确定性）
  // genesis 季节 → 天然偏向探索
  const uncertainty = 1 - confidence
  const seasonEpiBoost = season === 'genesis' ? 0.2 : 0
  const epistemicValue = clamp(uncertainty * 0.7 + seasonEpiBoost)

  // ── Pragmatic Value: 目标推进预期 ──
  // 高 confidence + 高 vigor → 高 pragmatic（可以执行）
  // wuwei 季节 → 无为而治，抑制执行
  const seasonFactor = season === 'wuwei' ? 0.3
    : season === 'genesis' ? 0.5
    : 1.0
  const pragmaticValue = clamp(confidence * vigorEnergy * seasonFactor)

  // ── Novelty Bonus: 探索奖励 ──
  // 新鲜感低 + 好奇心高 → 鼓励尝试新路径
  const freshnessInv = 1 - freshness
  const noveltyBonus = clamp(freshnessInv * 0.6 + curiosity * 0.4)

  // ── Precision: 置信度加权 ──
  // 高 vigor → 高 precision → 行为确定性高（exploitation）
  // 低 vigor → 低 precision → 行为随机性高（exploration）
  const precision = clamp(vigorEnergy, 0.3, 1.0)

  return { epistemicValue, pragmaticValue, noveltyBonus, precision }
}

export function adjustReasoningEffort(
  current: import('./auto-reasoning.js').ReasoningEffort,
  level: InterventionLevel,
): import('./auto-reasoning.js').ReasoningEffort {
  const order: import('./auto-reasoning.js').ReasoningEffort[] = ['off', 'low', 'medium', 'high', 'max']
  const idx = order.indexOf(current)

  if (level === 'escalate') {
    return order[Math.min(idx + 1, order.length - 1)]!
  }
  if (level === 'gate') {
    return order[Math.min(idx + 1, order.length - 1)]!
  }
  if (level === 'hint') {
    // Hint does not change reasoning effort unless already at max
    return current
  }
  return current
}
