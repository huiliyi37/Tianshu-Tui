import type { RiskLevel } from '../agent/approval-risk.js'
import type { EvidenceState } from '../agent/evidence.js'
import type { TraceStore } from '../agent/trace-store.js'
import type { CognitiveSeason } from '../agent/cognitive-season.js'
import type { Sensorium, StrategyProfile } from '../agent/sensorium.js'
import type { VigorState } from '../agent/vigor.js'
import { renderContractProjection, type TaskContract } from './task-contract.js'
import { buildUncertaintyFraming } from '../agent/uncertainty-framing.js'

export interface CognitiveLedgerInput {
  contract?: TaskContract
  evidence: EvidenceState
  trace: TraceStore
  turn: number
  /** Gen2 paravirtualization: model can see its own cognitive state */
  sensorium?: Sensorium | null
  strategy?: StrategyProfile | null
  vigor?: VigorState | null
  season?: CognitiveSeason | null
  /** Season intensity (0-1), from classifySeason().intensity */
  seasonIntensity?: number
  /** CVM trap: latest tool risk level for uncertainty framing */
  riskLevel?: RiskLevel
}

export interface CognitiveLedger {
  contract?: TaskContract
  evidence: EvidenceState
  trace: TraceStore
  turn: number
  sensorium?: Sensorium | null
  strategy?: StrategyProfile | null
  vigor?: VigorState | null
  season?: CognitiveSeason | null
  seasonIntensity?: number
  riskLevel?: RiskLevel
}

export interface CognitivePhaseSnapshot {
  contractStatus?: string
  objective?: string
  scopeFileCount: number
  isActionableTask: boolean
  hasVerificationGap: boolean
  deliveryStatus: string
}

export function createCognitiveLedger(input: CognitiveLedgerInput): CognitiveLedger {
  return {
    contract: input.contract,
    evidence: input.evidence,
    trace: input.trace,
    turn: input.turn,
    sensorium: input.sensorium ?? null,
    strategy: input.strategy ?? null,
    vigor: input.vigor ?? null,
    season: input.season ?? null,
    seasonIntensity: input.seasonIntensity,
    riskLevel: input.riskLevel,
  }
}

export function buildVerificationGapProjection(ledger: CognitiveLedger): string {
  const modifiedCount = ledger.evidence.filesModified.size
  if (modifiedCount === 0) return ''
  if (ledger.evidence.deliveryStatus !== 'unverified') return ''
  return `<verification-gap status="unverified" modified="${modifiedCount}">Run relevant verification before claiming done.</verification-gap>`
}

/**
 * 认知镜面 — CVM Gen2 paravirtualization
 *
 * 至人之用心若镜，不将不迎，应而不藏。（庄子·应帝王）
 * The sage's mind is like a mirror: it doesn't welcome or reject,
 * it reflects without storing.
 *
 * The cognitive mirror lets the model SEE its own cognitive state
 * before generating each turn. This is paravirtualization — the model
 * knows it's in the CVM and can actively adjust behavior.
 *
 * Visible dimensions (model reads these to adjust behavior):
 *   verification_coverage — how many modified files have been verified?
 *   files_modified — raw count so model can interpret vacuous coverage
 *   complexity — how diverse is the recent tool pattern?
 *   stability  — is the session healthy or approaching doom loop?
 *   strategy   — current reasoning effort + exploration breadth
 *   vigor      — phasic (acute arousal) + tonic (sustained) activation
 *
 * Routing-only dimensions (consumed by hooks from sensorium, NOT shown to model):
 *   freshness  — affordance scoring, EFE, star-event routing, CCR P2
 *   momentum   — shouldKick, prediction-error, retrospect
 *   pressure   — signal-consumer, model-policy-selection, reward-loop
 *
 * The mirror is CONCISE — it must not consume the cognitive oxygen
 * it's meant to protect (see Task 12: CVM overhead).
 */
export function buildCognitiveMirror(ledger: CognitiveLedger): string {
  const s = ledger.sensorium
  if (!s) return ''

  // Coarse-grain confidence and complexity to avoid false precision in early turns.
  // A 2-decimal float like "1.00" implies measurement granularity that doesn't exist
  // before any tools have run. Use low/mid/high bands until evidence accumulates.
  const hasEvidence = (ledger.evidence?.filesModified?.size ?? 0) > 0 || (ledger.evidence?.toolResults?.size ?? 0) > 0
  const confLabel = !hasEvidence ? coarseLabel(s.confidence) : formatDim(s.confidence)
  const parts: string[] = [`verification_coverage="${confLabel}"`]

  parts.push(`files_modified="${ledger.evidence.filesModified.size}"`)

  if (s.complexity !== undefined) {
    const cxLabel = !hasEvidence ? coarseLabel(s.complexity) : formatDim(s.complexity)
    parts.push(`complexity="${cxLabel}"`)
  }
  // momentum, freshness, pressure — routing-only: consumed by hooks from sensorium directly
  if (s.stability !== undefined) parts.push(`stability="${formatDim(s.stability)}"`)

  if (ledger.strategy) {
    const st = ledger.strategy
    if (st.reasoningEffort && st.reasoningEffort !== 'medium') parts.push(`reasoning="${st.reasoningEffort}"`)
    if (st.explorationBreadth !== undefined) parts.push(`exploration="${formatDim(st.explorationBreadth)}"`)
    if (st.commitThreshold !== undefined && st.commitThreshold > 0.7) parts.push(`caution="${formatDim(st.commitThreshold)}"`)
    if (st.shouldEscalate) parts.push(`escalation="true"`)
  }

  if (ledger.vigor) {
    const v = ledger.vigor
    parts.push(`vigor="${formatDim(v.vigor)}"`)
    if (v.curiosity > 0.3) parts.push(`curiosity="${formatDim(v.curiosity)}"`)
  }

  if (ledger.season) {
    const intensity = ledger.seasonIntensity
    const seasonVal = intensity !== undefined && intensity < 1.0
      ? `${ledger.season}:${formatDim(intensity)}`
      : ledger.season
    parts.push(`season="${seasonVal}"`)
  }

  return `<cognitive-mirror ${parts.join(' ')} />`
}

/** Format a 0–1 dimension value to 2 decimal places. */
function formatDim(value: number): string {
  return value.toFixed(2)
}

/** Coarse-grain a 0–1 value to low/mid/high for early-turn false-precision avoidance. */
function coarseLabel(value: number): string {
  if (value < 0.34) return 'low'
  if (value < 0.67) return 'mid'
  return 'high'
}

export interface CognitiveProjectionParts {
  /** State-derived projection (contract + verification gap + mirror + uncertainty).
   *  Delta-safe: changes in place when ledger state changes, so appendixDelta can
   *  diff it by content. */
  stable: string
  /** Per-turn one-shot hints (sycophancy / yaoguang / immune). Must be emitted
   *  OUTSIDE appendixDelta — under delta's cumulative "absent = reuse last"
   *  protocol a one-shot hint would otherwise persist across turns. */
  ephemeral: string
}

/**
 * Split the cognitive projection into a delta-safe stable part and per-turn
 * ephemeral hints. See {@link CognitiveProjectionParts}.
 */
export function buildCognitiveProjectionParts(
  ledger: CognitiveLedger,
  opts?: {
    sycophancyHint?: string | null
    immuneHint?: string | null
    yaoguangHint?: string | null
  },
): CognitiveProjectionParts {
  const stable = [
    ledger.contract ? renderContractProjection(ledger.contract) : '',
    buildVerificationGapProjection(ledger),
    buildCognitiveMirror(ledger),
    buildUncertaintyProjection(ledger),
  ].filter(Boolean).join('\n')
  const ephemeral = [
    opts?.sycophancyHint ?? '',
    opts?.yaoguangHint ?? '',
    opts?.immuneHint ?? '',
  ].filter(Boolean).join('\n')
  return { stable, ephemeral }
}

export function buildCognitivePromptProjection(
  ledger: CognitiveLedger,
  opts?: {
    sycophancyHint?: string | null
    immuneHint?: string | null
    yaoguangHint?: string | null
  },
): string {
  const { stable, ephemeral } = buildCognitiveProjectionParts(ledger, opts)
  return [stable, ephemeral].filter(Boolean).join('\n')
}

/**
 * Uncertainty Framing — 万物为一原则④ "模糊是力量"
 *
 * When sensorium.confidence < 0.4 + risk >= medium, inject structured
 * uncertainty hint into cognitive projection. This is the CVM trap for
 * preventing overconfident destructive actions.
 */
function buildUncertaintyProjection(ledger: CognitiveLedger): string {
  const confidence = ledger.sensorium?.confidence
  const riskLevel = ledger.riskLevel
  if (confidence === undefined || confidence === null || !riskLevel) return ''
  const framing = buildUncertaintyFraming({ confidence, riskLevel })
  return framing.hint ?? ''
}

export function getCognitivePhaseSnapshot(ledger: CognitiveLedger): CognitivePhaseSnapshot {
  return {
    contractStatus: ledger.contract?.status,
    objective: ledger.contract?.objective,
    scopeFileCount: ledger.contract?.scope.mentionedFiles.length ?? 0,
    isActionableTask: ledger.contract?.isActionable ?? false,
    hasVerificationGap: buildVerificationGapProjection(ledger).length > 0,
    deliveryStatus: ledger.evidence.deliveryStatus,
  }
}
