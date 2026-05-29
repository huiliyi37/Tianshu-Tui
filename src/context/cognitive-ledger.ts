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
  /** CVM trap: latest tool risk level for uncertainty framing */
  riskLevel?: RiskLevel
  /** Meta-regulation: current regulation pressure (0-1) */
  regulationPressure?: number
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
  riskLevel?: RiskLevel
  regulationPressure?: number
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
    riskLevel: input.riskLevel,
    regulationPressure: input.regulationPressure,
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
 * Six sensorium dimensions + strategy + vigor:
 *   verification_coverage — how many modified files have been verified? (not general confidence)
 *   complexity — how diverse is the recent tool pattern?
 *   momentum   — are we accelerating or coasting?
 *   stability  — is the session healthy or approaching doom loop?
 *   freshness  — how familiar is the current file context?
 *   pressure   — is the context window filling up?
 *   files_modified — raw count so model can interpret vacuous coverage
 *   strategy   — current reasoning effort + exploration breadth
 *   vigor      — phasic (acute arousal) + tonic (sustained) activation
 *
 * The mirror is CONCISE — it must not consume the cognitive oxygen
 * it's meant to protect (see Task 12: CVM overhead).
 */
export function buildCognitiveMirror(ledger: CognitiveLedger): string {
  const s = ledger.sensorium
  if (!s) return ''

  const parts: string[] = [`verification_coverage="${formatDim(s.confidence)}"`]

  // Show how many files have been modified so the model can interpret
  // verification_coverage correctly. When files_modified=0,
  // verification_coverage=1.00 is vacuously true (0/0 = all verified).
  parts.push(`files_modified="${ledger.evidence.filesModified.size}"`)

  if (s.complexity !== undefined) parts.push(`complexity="${formatDim(s.complexity)}"`)
  if (s.momentum !== undefined) parts.push(`momentum="${formatDim(s.momentum)}"`)
  if (s.stability !== undefined) parts.push(`stability="${formatDim(s.stability)}"`)
  if (s.freshness !== undefined) parts.push(`freshness="${formatDim(s.freshness)}"`)
  if (s.pressure !== undefined) parts.push(`pressure="${formatDim(s.pressure)}"`)

  // Strategy profile: most actionable dimension
  if (ledger.strategy) {
    const st = ledger.strategy
    if (st.reasoningEffort && st.reasoningEffort !== 'medium') parts.push(`reasoning="${st.reasoningEffort}"`)
    if (st.explorationBreadth !== undefined) parts.push(`exploration="${formatDim(st.explorationBreadth)}"`)
    if (st.commitThreshold !== undefined && st.commitThreshold > 0.7) parts.push(`caution="${formatDim(st.commitThreshold)}"`)
    if (st.shouldEscalate) parts.push(`escalation="true"`)
  }

  // Vigor: phasic arousal level — when high, model should act with urgency
  if (ledger.vigor) {
    const v = ledger.vigor
    const tonic = v.tonic ?? v.phasic ?? 0.5
    parts.push(`vigor="${formatDim(tonic)}"`)
  }

  // Season: 道德经四章螺旋 — session lifecycle phase
  if (ledger.season) {
    parts.push(`season="${ledger.season}"`)
  }

  // Regulation cost: let model see its own regulation overhead
  if (ledger.regulationPressure !== undefined && ledger.regulationPressure > 0) {
    parts.push(`regulation-cost="${formatDim(ledger.regulationPressure)}"`)
  }

  return `<cognitive-mirror ${parts.join(' ')} />`
}

/** Format a 0–1 dimension value to 2 decimal places. */
function formatDim(value: number): string {
  return value.toFixed(2)
}

export function buildCognitivePromptProjection(
  ledger: CognitiveLedger,
  opts?: {
    sycophancyHint?: string | null
    immuneHint?: string | null
  },
): string {
  return [
    ledger.contract ? renderContractProjection(ledger.contract) : '',
    buildVerificationGapProjection(ledger),
    buildCognitiveMirror(ledger),
    buildUncertaintyProjection(ledger),
    opts?.sycophancyHint ?? '',
    opts?.immuneHint ?? '',
  ].filter(Boolean).join('\n')
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
