/**
 * Track 1: 统一 bandit shadow→gated 晋升闸。
 *
 * 替代手动 feature flag 的统一晋升机制：每个 bandit 路径（model tier、team
 * scheduler、EFE model routing、effort delta）共享同一套「样本量达标 + 无
 * false-green + scope 健康 + 正向 reward margin → 自动 gated」证据闸。
 *
 * 四档模式：
 * - `off`     一键回退：无论证据如何，永不 apply（kill switch 语义）。
 * - `shadow`  默认：只收集证据，永不 apply。
 * - `auto`    晋升闸决定：证据达标自动 gated，证据退化自动回到 shadow。
 * - `forced`  手动覆盖：等价旧 `*Enabled: true`，无视证据直接 apply。
 *
 * 决策只读取 append-only 的遥测/审计存储（meridian DB），评估在会话建立时
 * 进行 — 晋升以会话为粒度，回滚立即生效（mode 改 off 即全关）。
 */

import type { GatedInfluenceSource } from './gated-influence-audit.js'
import {
  evaluateGatedInfluenceHistory,
  type GatedInfluenceEvaluationReport,
  type GatedInfluenceEvaluationStore,
} from './gated-influence-evaluation.js'

export type BanditPromotionMode = 'off' | 'shadow' | 'auto' | 'forced'

export interface BanditPromotionThresholds {
  /** Minimum shadow samples before auto promotion can be considered. */
  minSamples: number
  /** Minimum positive reward margin (candidate − baseline) required for auto promotion. */
  minRewardMargin: number
}

export const DEFAULT_PROMOTION_THRESHOLDS: BanditPromotionThresholds = {
  minSamples: 30,
  minRewardMargin: 0.05,
}

export interface BanditPromotionDecision {
  source: GatedInfluenceSource
  mode: BanditPromotionMode
  /** Final answer consumed by the feature-flag seam. */
  enabled: boolean
  reason: string
  evidence: {
    totalShadowSamples: number
    falseGreenRate?: number
    worstScopeSeverity?: string
    /** Max observed reward margin from gated-influence audits (candidate − baseline). */
    rewardMargin?: number
  }
}

export interface ResolveBanditPromotionInput {
  source: GatedInfluenceSource
  mode: BanditPromotionMode
  store?: GatedInfluenceEvaluationStore | null
  thresholds?: Partial<BanditPromotionThresholds>
  /** Injectable pre-computed report (tests / shared evaluation across sources). */
  report?: GatedInfluenceEvaluationReport
}

/**
 * Resolve the effective mode from the new mode config + legacy boolean flag.
 *
 * Legacy `*Enabled: true` keeps working as `forced` when the mode config is
 * still at its `shadow` default; an explicit mode always wins. `killSwitch`
 * overrides everything — one-key rollback across all bandit paths.
 */
export function effectiveBanditMode(
  mode: BanditPromotionMode | undefined,
  legacyEnabled: boolean | undefined,
  killSwitch: boolean | undefined,
): BanditPromotionMode {
  if (killSwitch === true) return 'off'
  const configured = mode ?? 'shadow'
  if (configured !== 'shadow') return configured
  return legacyEnabled === true ? 'forced' : 'shadow'
}

export function resolveBanditPromotion(input: ResolveBanditPromotionInput): BanditPromotionDecision {
  const thresholds: BanditPromotionThresholds = {
    ...DEFAULT_PROMOTION_THRESHOLDS,
    ...input.thresholds,
  }

  const base = (enabled: boolean, reason: string, evidence?: BanditPromotionDecision['evidence']): BanditPromotionDecision => ({
    source: input.source,
    mode: input.mode,
    enabled,
    reason,
    evidence: evidence ?? { totalShadowSamples: 0 },
  })

  if (input.mode === 'off') return base(false, 'kill switch: mode=off')
  if (input.mode === 'forced') return base(true, 'manual override: mode=forced')
  if (input.mode === 'shadow') return base(false, 'shadow only: collecting evidence')

  // mode === 'auto' — evidence-driven promotion
  let report: GatedInfluenceEvaluationReport
  try {
    report = input.report ?? evaluateGatedInfluenceHistory(input.store)
  } catch {
    return base(false, 'auto: evidence store unavailable')
  }

  const metrics = report.sources[input.source]
  if (!metrics) return base(false, `auto: no metrics for source ${input.source}`)

  const evidence: BanditPromotionDecision['evidence'] = {
    totalShadowSamples: metrics.totalShadowSamples,
    ...(metrics.falseGreenRate !== undefined ? { falseGreenRate: metrics.falseGreenRate } : {}),
    ...(metrics.worstScopeSeverity !== undefined ? { worstScopeSeverity: metrics.worstScopeSeverity } : {}),
    ...(metrics.regretEstimate !== undefined ? { rewardMargin: metrics.regretEstimate } : {}),
  }

  if (metrics.totalShadowSamples < thresholds.minSamples) {
    return base(false, `auto: samples ${metrics.totalShadowSamples}/${thresholds.minSamples}`, evidence)
  }
  if ((metrics.falseGreenRate ?? 0) > 0) {
    return base(false, 'auto: false-green observed — demoted to shadow', evidence)
  }
  if (metrics.worstScopeSeverity === 'medium' || metrics.worstScopeSeverity === 'high') {
    return base(false, `auto: scope-health veto ${metrics.worstScopeSeverity}`, evidence)
  }
  const margin = metrics.regretEstimate
  if (margin === undefined || margin < thresholds.minRewardMargin) {
    return base(false, `auto: reward margin ${margin === undefined ? 'unknown' : margin.toFixed(3)} < ${thresholds.minRewardMargin}`, evidence)
  }

  return base(true, `auto: promoted (samples=${metrics.totalShadowSamples}, margin=${margin.toFixed(3)})`, evidence)
}
