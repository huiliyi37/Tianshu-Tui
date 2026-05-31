import type { PredictionAccumulator } from './prediction-error.js'
import type { ReasoningEffort } from './auto-reasoning.js'
import type { FailureClass } from './failure-classifier.js'
import type { Sensorium, StrategyProfile } from './sensorium.js'

export interface VigorState {
  /** Minute-scale motivational baseline, derived from prediction success. */
  tonic: number
  /** Instant reward prediction error: actual outcome minus expected outcome. */
  phasic: number
  /** Information-gap drive: high complexity with low confidence. */
  curiosity: number
  /** Integrated behavioral energy output. */
  vigor: number
  /** Rolling standard deviation of recent vigor values; HRV analogue. */
  variability: number
  /** Recent vigor values, capped to a small rolling window. */
  history: number[]
}

export interface VigorUpdateInput {
  toolSuccess: boolean
  sensorium: Sensorium
  predictionAcc?: PredictionAccumulator
  /** Failure classification — enables vigor to distinguish semantic failures
   *  (type_error, assertion) from environment issues (timeout, api_error).
   *  When absent, treats failure as generic (weight = 1.0). */
  failureClass?: FailureClass
}

const DEFAULT_HISTORY_LIMIT = 10
const TONIC_ALPHA = 0.15

/**
 * Failure class → phasic weight mapping.
 *
 * Semantic failures (type_error, assertion) indicate cognitive prediction errors
 * and should produce full phasic penalty. Environment issues (timeout, api_error)
 * are not the agent's fault and should produce reduced penalty.
 *
 * Weight 1.0 = full penalty, 0.5 = half penalty, 0.2 = minimal penalty.
 */
const FAILURE_CLASS_PHASIC_WEIGHT: ReadonlyMap<FailureClass, number> = new Map<FailureClass, number>([
  // Environment / transient issues — not agent's fault
  ['timeout', 0.5],
  ['api_error', 0.5],
  ['flaky', 0.5],
  // Environment missing — external dependency issue
  ['missing_dep', 0.2],
  ['permission_denied', 0.2],
  ['env_missing', 0.2],
  // Semantic failures — agent's cognitive error
  ['type_error', 1.0],
  ['assertion', 1.0],
  ['syntax_error', 1.0],
  ['module_resolution', 1.0],
  // Other — default full penalty
  ['snapshot', 1.0],
  ['format_error', 1.0],
  ['context_window_exceeded', 0.5],
  ['unknown', 1.0],
])

function clamp01(value: number): number {
  return Math.max(0, Math.min(1, value))
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value))
}

function round(value: number): number {
  return Math.round(value * 1_000_000) / 1_000_000
}

function computeStd(values: number[]): number {
  if (values.length < 2) return 0
  const mean = values.reduce((sum, value) => sum + value, 0) / values.length
  const variance = values.reduce((sum, value) => sum + (value - mean) ** 2, 0) / values.length
  return Math.sqrt(variance)
}

function successRate(acc: PredictionAccumulator): number | null {
  if (acc.predictions.length === 0) return null
  const successes = acc.predictions.filter(Boolean).length
  return successes / acc.predictions.length
}

function stepReasoningEffort(current: ReasoningEffort, delta: -1 | 1): ReasoningEffort {
  const order: ReasoningEffort[] = ['off', 'low', 'medium', 'high', 'max']
  const idx = order.indexOf(current)
  if (idx < 0) return current
  return order[clamp(idx + delta, 0, order.length - 1)]!
}

export function createVigorState(overrides: Partial<VigorState> = {}): VigorState {
  const base: VigorState = {
    tonic: 0.5,
    phasic: 0,
    curiosity: 0,
    vigor: 0.5,
    variability: 0,
    history: [],
  }
  return { ...base, ...overrides }
}

/**
 * Update the Vigor state from a tool outcome and the current Sensorium.
 *
 * Vigor is the motivational projection of the existing cerebellar prediction
 * loop: prediction error changes energy, while Sensorium still owns strategy.
 *
 * When failureClass is provided, the phasic penalty is scaled by the failure
 * class weight — environment issues (timeout, api_error) produce reduced penalty,
 * while semantic failures (type_error, assertion) produce full penalty.
 */
export function updateVigor(prev: VigorState, input: VigorUpdateInput): VigorState {
  const actual = input.toolSuccess ? 1 : 0
  const predicted = clamp01(prev.tonic)
  const rawPhasic = actual - predicted

  // Scale phasic by failure class weight:
  // - Semantic failures (type_error, assertion) → weight 1.0 → full penalty
  // - Environment issues (timeout, api_error) → weight 0.5 → half penalty
  // - Missing deps (missing_dep, permission_denied) → weight 0.2 → minimal penalty
  // - No failureClass → weight 1.0 → full penalty (backward compatible)
  const phasicWeight = input.failureClass
    ? (FAILURE_CLASS_PHASIC_WEIGHT.get(input.failureClass) ?? 1.0)
    : 1.0
  const phasic = rawPhasic * phasicWeight

  const observedSuccessRate = input.predictionAcc ? successRate(input.predictionAcc) : null
  const tonicTarget = observedSuccessRate ?? actual
  const tonic = clamp01(TONIC_ALPHA * tonicTarget + (1 - TONIC_ALPHA) * predicted)

  const curiosity = input.sensorium.complexity > 0.5 && input.sensorium.confidence < 0.4
    ? clamp01(input.sensorium.complexity - input.sensorium.confidence)
    : 0

  const rawVigor = tonic + 0.3 * phasic + 0.2 * curiosity
  const vigor = clamp01(rawVigor)
  const history = [...prev.history, vigor].slice(-DEFAULT_HISTORY_LIMIT)
  const variability = computeStd(history)

  return {
    tonic: round(tonic),
    phasic: round(phasic),
    curiosity: round(curiosity),
    vigor: round(vigor),
    variability: round(variability),
    history,
  }
}

/**
 * HRV analogue: pathologically constant vigor means the runtime may be rigid.
 */
export function detectRigidity(history: number[], windowSize = DEFAULT_HISTORY_LIMIT, threshold = 0.05): boolean {
  if (history.length < windowSize) return false
  const recent = history.slice(-windowSize)
  return computeStd(recent) < threshold
}

/**
 * Vigor modulates Sensorium-derived strategy; it does not replace it.
 */
export function modulateStrategyByVigor(
  strategy: StrategyProfile,
  vigor: VigorState,
  sensorium: Sensorium,
): StrategyProfile {
  let adjusted: StrategyProfile = { ...strategy }

  if (vigor.vigor < 0.3 || vigor.phasic < -0.5) {
    adjusted = {
      ...adjusted,
      reasoningEffort: stepReasoningEffort(adjusted.reasoningEffort, 1),
      commitThreshold: clamp01(Math.max(adjusted.commitThreshold, adjusted.commitThreshold + 0.15)),
      thetaCycleInterval: Math.max(2, adjusted.thetaCycleInterval - 1),
    }
  }

  const canSpeedUp = vigor.vigor > 0.7 && sensorium.complexity < 0.5 && sensorium.confidence > 0.7
  if (canSpeedUp) {
    adjusted = {
      ...adjusted,
      reasoningEffort: stepReasoningEffort(adjusted.reasoningEffort, -1),
      commitThreshold: clamp01(adjusted.commitThreshold - 0.1),
      thetaCycleInterval: Math.min(9, adjusted.thetaCycleInterval + 1),
    }
  }

  if (vigor.curiosity > 0.6) {
    adjusted = {
      ...adjusted,
      explorationBreadth: clamp01(Math.max(adjusted.explorationBreadth, adjusted.explorationBreadth + 0.3)),
    }
  }

  return adjusted
}

/**
 * ELM micro-release: when everything has been too smooth for too long,
 * request a small verification pulse instead of waiting for a large failure.
 */
export function shouldTriggerElmRelease(
  vigor: VigorState,
  threshold = 0.8,
  minRecent = 5,
): boolean {
  if (vigor.vigor <= threshold) return false
  const recent = vigor.history.slice(-minRecent)
  if (recent.length < minRecent) return false
  return recent.every(value => value > threshold)
}
