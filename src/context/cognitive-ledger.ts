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
  /** Convergence precision (0-1), composite score from convergence detector signals */
  convergencePrecision?: number
  /** Output token efficiency (0-1), from convergence detector signals.tokenEfficiency */
  outputEfficiency?: number
  /** W4（incident 20b9714e）：上下文占用比（0-1，pressureResult.ratio）。
   *  渲染成 10% 桶——给模型可引用的硬数字，替代"窗口紧张"类脑补。 */
  ctxRatio?: number
  /** 上下文窗口 token 数（会话内恒定），渲染成 1M/200K 等标签。 */
  ctxWindow?: number
  /** T5: 美德 mirror 字段 — renderMirror() 产出，Fibonacci 桶量化 + 固定排序。
   *  Null 时整段省略。无条件传入；渲染由 cognitive-prep 的 actionable gate 控制。 */
  virtue?: string | null
  /** 证据义务结构化摘要（ObligationTracker.renderBlock() 产出，字节稳定）。
   *  非空时替代泛化的 verification-gap 文案——当前断言、证据状态、下一动作
   *  一目了然；空/缺省时回退旧 verification-gap 行为（无义务 ≠ 无验证缺口）。 */
  obligationBlock?: string | null
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
  convergencePrecision?: number
  outputEfficiency?: number
  ctxRatio?: number
  ctxWindow?: number
  virtue?: string | null
  obligationBlock?: string | null
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
    convergencePrecision: input.convergencePrecision,
    outputEfficiency: input.outputEfficiency,
    ctxRatio: input.ctxRatio,
    ctxWindow: input.ctxWindow,
    virtue: input.virtue ?? null,
    obligationBlock: input.obligationBlock ?? null,
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

  // verification_coverage must be semantically honest: it reports the ratio of
  // modified files that have been verified. When no verification command has
  // actually run, showing "high" or "1.00" gives a false sense of safety.
  // All continuous dims render as low/mid/high bands (2026-07-06): the mirror
  // rides the appendixDelta, and 2-decimal floats drift every turn — the block
  // never went byte-quiet. Band transitions are exactly the state changes the
  // model should perceive, so byte-diff on coarse labels ≡ "notify on transition".
  // The special literals below stay exact: they're already constant and
  // semantically precise (none / 0.00 honest-warning / 1.00 fully-verified).
  const filesModifiedCount = ledger.evidence?.filesModified?.size ?? 0
  const verificationRuns = ledger.evidence?.verifications?.length ?? 0
  let confLabel: string
  if (verificationRuns === 0) {
    confLabel = filesModifiedCount === 0 ? 'none' : '0.00'
  } else {
    confLabel = filesModifiedCount === 0 ? '1.00' : coarseLabel(s.confidence)
  }
  const parts: string[] = [`verification_coverage="${confLabel}"`]

  parts.push(`files_modified="${ledger.evidence.filesModified.size}"`)

  if (s.complexity !== undefined) {
    parts.push(`complexity="${coarseLabel(s.complexity)}"`)
  }
  // momentum, freshness, pressure — routing-only: consumed by hooks from sensorium directly
  if (s.stability !== undefined) parts.push(`stability="${coarseLabel(s.stability)}"`)

  if (ledger.strategy) {
    const st = ledger.strategy
    if (st.reasoningEffort && st.reasoningEffort !== 'medium') parts.push(`reasoning="${st.reasoningEffort}"`)
    if (st.explorationBreadth !== undefined) parts.push(`exploration="${coarseLabel(st.explorationBreadth)}"`)
    if (st.commitThreshold !== undefined && st.commitThreshold > 0.7) parts.push(`caution="${coarseLabel(st.commitThreshold)}"`)
    if (st.shouldEscalate) parts.push(`escalation="true"`)
  }

  if (ledger.vigor) {
    const v = ledger.vigor
    parts.push(`vigor="${coarseLabel(v.vigor)}"`)
    if (v.curiosity > 0.3) parts.push(`curiosity="${coarseLabel(v.curiosity)}"`)
  }

  if (ledger.season) {
    const intensity = ledger.seasonIntensity
    const seasonVal = intensity !== undefined && intensity < 1.0
      ? `${ledger.season}:${coarseLabel(intensity)}`
      : ledger.season
    parts.push(`season="${seasonVal}"`)
  }

  // T5: 美德入 mirror — 通道 A（appendixDelta），Fibonacci 桶字节稳定。
  if (ledger.virtue) {
    parts.push(ledger.virtue)
  }

  if (ledger.convergencePrecision !== undefined) parts.push(`convergence_precision="${coarseLabel(ledger.convergencePrecision)}"`)
  if (ledger.convergencePrecision !== undefined) parts.push(`convergence_precision="${coarseLabel(ledger.convergencePrecision)}"`)
  if (ledger.outputEfficiency !== undefined) parts.push(`output_efficiency="${coarseLabel(ledger.outputEfficiency)}"`)

  // W4（incident 20b9714e）：常驻上下文占用硬数据。pressure 复合值仍是
  // routing-only——这里给的是可直接引用的原始数字（"ctx≈30%·1M"），让
  // "窗口紧张"类断言有处锚定。10% 桶量化保证字节稳定：桶变才字节变，
  // 与 mirror 的 low/mid/high 档位纪律同一口径（appendixDelta 兼容）。
  if (ledger.ctxRatio !== undefined) {
    const bucket = Math.min(90, Math.floor(ledger.ctxRatio * 10) * 10)
    const win = ledger.ctxWindow !== undefined ? `·${formatWindowLabel(ledger.ctxWindow)}` : ''
    parts.push(`ctx="${bucket}%${win}"`)
  }

  return `<cognitive-mirror ${parts.join(' ')} />`
}

/** Context-window label: 1_000_000 → "1M", 200_000 → "200K". Constant per session. */
function formatWindowLabel(tokens: number): string {
  if (tokens >= 1_000_000) return `${Math.round(tokens / 1_000_000)}M`
  return `${Math.round(tokens / 1_000)}K`
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
  // 义务块非空时替代 verification-gap：同一"改了没验证"事实由结构化义务
  // 表达（含下一动作），不再叠加一行泛化文案（worker_claim_single_voice 同哲学）。
  const stable = [
    ledger.contract ? renderContractProjection(ledger.contract) : '',
    ledger.obligationBlock || buildVerificationGapProjection(ledger),
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
