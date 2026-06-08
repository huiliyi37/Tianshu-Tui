import type { EFEComponents } from './prediction-error.js'
import type { Sensorium } from './sensorium.js'
import type { ModelCapabilityCard } from '../model/capability.js'

export type ModelPolicyTier = 'cheap' | 'balanced' | 'strong'

export interface ModelPolicyCandidate {
  model: string
  tier: ModelPolicyTier
  /** normalized 0..1, non-finite values are treated as neutral */
  estimatedCost: number
  /** normalized 0..1, non-finite values are treated as neutral */
  estimatedLatency: number
  /** probability-like success estimate, 0..1 */
  predictedSuccess: number
  /** fit for high-risk / false-green-sensitive work, 0..1 */
  riskFit: number
  /** Reserved for P3 authority→tier routing. P2 keeps it as a weak hint only. */
  authorityFit?: number
  /** P1 reward closure summary, -1..1; missing/non-finite is neutral 0. */
  historicalReward?: number
}

export interface SelectModelPolicyInput {
  candidates: ModelPolicyCandidate[]
  efe: EFEComponents
  sensorium: Pick<Sensorium, 'complexity' | 'pressure' | 'confidence' | 'stability'>
  topK?: number
}

export interface ModelPolicySelection {
  model: string
  tier: ModelPolicyTier
  expectedFreeEnergy: number
  candidate: ModelPolicyCandidate
}

export interface BuildModelPolicyCandidatesOptions {
  /** Model → average P1 reward closure summary. Missing models stay neutral. */
  historicalRewards?: Record<string, number | undefined>
}

const TIER_COST: Record<ModelPolicyTier, number> = {
  cheap: 0.18,
  balanced: 0.48,
  strong: 0.82,
}

const TIER_LATENCY: Record<ModelPolicyTier, number> = {
  cheap: 0.20,
  balanced: 0.45,
  strong: 0.70,
}

function clamp(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min
  return Math.min(max, Math.max(min, value))
}

function unit(value: number | undefined, neutral = 0.5): number {
  if (value === undefined || !Number.isFinite(value)) return neutral
  return clamp(value, 0, 1)
}

function reward(value: number | undefined): number {
  if (value === undefined || !Number.isFinite(value)) return 0
  return clamp(value, -1, 1)
}

function round6(value: number): number {
  return Math.round(value * 1_000_000) / 1_000_000
}

function failureRisk(input: {
  predictedSuccess: number
  riskFit: number
  sensorium: Pick<Sensorium, 'complexity' | 'pressure' | 'confidence' | 'stability'>
}): number {
  const { predictedSuccess, riskFit, sensorium } = input
  const missRisk = 1 - predictedSuccess
  const falseGreenRisk = 1 - riskFit
  const contextAmplifier = clamp(
    0.50 +
    0.30 * unit(sensorium.complexity) +
    0.30 * unit(sensorium.pressure) +
    0.25 * (1 - unit(sensorium.confidence)) +
    0.15 * (1 - unit(sensorium.stability)),
    0.50,
    1.40,
  )

  return unit((0.55 * missRisk + 0.45 * falseGreenRisk) * contextAmplifier)
}

/**
 * Compute shadow-only model Expected Free Energy.
 *
 * Lower G is better. Inputs are clamped before scoring; the final value is
 * bounded to keep ordering stable even if future callers feed out-of-range
 * telemetry. False-green/failure risk is intentionally heavier than any cost
 * advantage, so a risky cheap model cannot win a high-risk turn by being cheap.
 */
export function computeModelG(input: {
  candidate: ModelPolicyCandidate
  efe: EFEComponents
  sensorium: Pick<Sensorium, 'complexity' | 'pressure' | 'confidence' | 'stability'>
}): number {
  const c = input.candidate
  const sensorium = input.sensorium
  const predictedSuccess = unit(c.predictedSuccess)
  const riskFit = unit(c.riskFit)
  const estimatedCost = unit(c.estimatedCost)
  const estimatedLatency = unit(c.estimatedLatency)
  const authorityFit = c.authorityFit === undefined ? 0 : unit(c.authorityFit)
  const historicalReward = reward(c.historicalReward)

  const epistemicNeed = unit(
    unit(input.efe.epistemicValue) +
    0.25 * (1 - unit(sensorium.confidence)) +
    0.15 * unit(sensorium.complexity) +
    0.05 * unit(input.efe.noveltyBonus),
  )
  const pragmaticNeed = unit(
    unit(input.efe.pragmaticValue) +
    0.25 * unit(sensorium.pressure) +
    0.15 * (1 - unit(sensorium.stability)),
  )

  const costSensitivity = clamp(
    1 -
    0.45 * unit(sensorium.complexity) -
    0.35 * unit(sensorium.pressure) -
    0.30 * (1 - unit(sensorium.confidence)),
    0.15,
    1,
  )
  const latencySensitivity = clamp(
    0.35 +
    0.35 * unit(sensorium.pressure) +
    0.15 * (1 - unit(sensorium.stability)),
    0.25,
    0.85,
  )

  const rewardWeight = 0.35
  const costWeight = 0.42 * costSensitivity
  const latencyWeight = 0.24 * latencySensitivity
  const riskPenalty = 1.05 +
    0.55 * unit(sensorium.pressure) +
    0.35 * unit(sensorium.complexity) +
    0.45 * (1 - unit(sensorium.confidence))

  const g =
    -epistemicNeed * predictedSuccess -
    pragmaticNeed * riskFit -
    0.10 * authorityFit -
    rewardWeight * historicalReward +
    costWeight * estimatedCost +
    latencyWeight * estimatedLatency +
    riskPenalty * failureRisk({ predictedSuccess, riskFit, sensorium })

  return round6(clamp(g, -3, 3))
}

export function selectModelPolicy(input: SelectModelPolicyInput): ModelPolicySelection[] {
  const topK = Math.max(0, Math.floor(input.topK ?? input.candidates.length))
  if (topK === 0 || input.candidates.length === 0) return []

  return input.candidates
    .filter(candidate => candidate.model.trim().length > 0)
    .map(candidate => ({
      model: candidate.model,
      tier: candidate.tier,
      expectedFreeEnergy: computeModelG({ candidate, efe: input.efe, sensorium: input.sensorium }),
      candidate,
    }))
    .sort((a, b) =>
      a.expectedFreeEnergy - b.expectedFreeEnergy ||
      a.model.localeCompare(b.model),
    )
    .slice(0, topK)
}

export function buildModelPolicyCandidates(
  cards: ModelCapabilityCard[] | undefined,
  options: BuildModelPolicyCandidatesOptions = {},
): ModelPolicyCandidate[] {
  if (!cards || cards.length === 0) return []
  return cards.map(card => {
    const tier = inferTier(card)
    const capabilityAverage = averageCapability(card)
    const contextFit = unit(card.contextWindow / 1_000_000)
    const predictedSuccess = unit(
      0.30 * unit(card.toolUseReliability) +
      0.20 * unit(card.jsonStability) +
      0.25 * unit(card.editSuccessRate) +
      0.25 * unit(card.testRepairRate),
    )
    const riskFit = unit(
      0.30 * unit(card.toolUseReliability) +
      0.20 * unit(card.jsonStability) +
      0.20 * unit(card.editSuccessRate) +
      0.25 * unit(card.testRepairRate) +
      0.05 * contextFit,
    )

    return {
      model: card.model,
      tier,
      estimatedCost: estimateCost(card, tier),
      estimatedLatency: estimateLatency(card, tier, capabilityAverage),
      predictedSuccess,
      riskFit,
      historicalReward: reward(options.historicalRewards?.[card.model]),
    }
  })
}

function averageCapability(card: ModelCapabilityCard): number {
  return unit((
    unit(card.toolUseReliability) +
    unit(card.jsonStability) +
    unit(card.editSuccessRate) +
    unit(card.testRepairRate)
  ) / 4)
}

function inferTier(card: ModelCapabilityCard): ModelPolicyTier {
  const name = card.model.toLowerCase()
  if (/\b(flash|mini|lite|cheap|small|haiku)\b|m2/.test(name)) return 'cheap'
  if (/\b(pro|strong|large|opus|max|ultra)\b|gpt-5/.test(name)) return 'strong'

  const capabilityAverage = averageCapability(card)
  if (capabilityAverage >= 0.82 || card.contextWindow >= 800_000) return 'strong'
  if (capabilityAverage <= 0.55 && card.contextWindow <= 256_000) return 'cheap'
  return 'balanced'
}

function estimateCost(card: ModelCapabilityCard, tier: ModelPolicyTier): number {
  const cacheAdjustment = card.cacheEconomics === 'strong' ? -0.08
    : card.cacheEconomics === 'weak' ? 0.06
    : 0
  const contextPremium = card.contextWindow >= 800_000 ? 0.04 : 0
  return unit(TIER_COST[tier] + cacheAdjustment + contextPremium)
}

function estimateLatency(card: ModelCapabilityCard, tier: ModelPolicyTier, capabilityAverage: number): number {
  const contextPremium = card.contextWindow >= 800_000 ? 0.05 : 0
  const reliabilityDiscount = capabilityAverage >= 0.85 ? -0.04 : 0
  return unit(TIER_LATENCY[tier] + contextPremium + reliabilityDiscount)
}
