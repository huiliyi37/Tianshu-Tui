export type InterventionLevel = 'none' | 'hint' | 'gate' | 'escalate'

export interface PredictionAccumulator {
  windowSize: number
  predictions: boolean[] // true = correct, false = error
  consecutiveCorrect: number
}

export function createPredictionAccumulator(windowSize = 10): PredictionAccumulator {
  return { windowSize, predictions: [], consecutiveCorrect: 0 }
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

export function resetAccumulator(acc: PredictionAccumulator): PredictionAccumulator {
  return { ...acc, predictions: [], consecutiveCorrect: 0 }
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
