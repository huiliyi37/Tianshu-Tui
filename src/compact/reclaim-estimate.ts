import type { OaiMessage } from '../api/oai-types.js'
import { estimateOaiTokens } from './micro.js'
import type { CompactionAction, CompactionProfile } from './compaction-profile.js'

/**
 * Effective-reclaim gate (2026-07-16 reclaim gate plan §3.3).
 *
 * Deterministic rewrites (diet / stale-round / micro) used to commit their
 * candidate unconditionally: session 2c1186f5 showed rewrites that reclaimed
 * only 617–1,701 tokens (or even *grew* the input) while shattering a
 * 200k+-token hot prefix cache each time. These pure functions sit between
 * "candidate produced" and "history replaced": a candidate must prove it
 * reclaims enough context to be worth the cache-miss rebuild, or the original
 * messages stay untouched and the next boundary retries.
 *
 * Token math uses estimateOaiTokens — the same estimator the compaction
 * ladder plans with — never message counts or raw char lengths.
 */

export interface ReclaimEstimate {
  beforeTokens: number
  afterTokens: number
  reclaimedTokens: number
  /** reclaimedTokens / beforeTokens, clamped to 0 when nothing was reclaimed. */
  reclaimRatio: number
  /** True when the candidate differs from the original at all (reference or bytes). */
  changed: boolean
}

export type ReclaimSkipReason = 'unchanged' | 'no-reclaim' | 'below-reclaim-floor'
export type ReclaimCommitReason = 'reclaim-above-floor' | 'forced'

export interface ReclaimVerdict {
  commit: boolean
  reason: ReclaimSkipReason | ReclaimCommitReason
}

function messagesChanged(before: OaiMessage[], after: OaiMessage[]): boolean {
  if (before === after) return false
  if (before.length !== after.length) return true
  for (let i = 0; i < before.length; i++) {
    if (before[i] !== after[i]) {
      // Different reference — compare serialized bytes to avoid false
      // positives from transforms that rebuild identical messages.
      if (JSON.stringify(before[i]) !== JSON.stringify(after[i])) return true
    }
  }
  return false
}

export function estimateReclaim(before: OaiMessage[], after: OaiMessage[]): ReclaimEstimate {
  const beforeTokens = estimateOaiTokens(before)
  const afterTokens = estimateOaiTokens(after)
  const reclaimedTokens = beforeTokens - afterTokens
  return {
    beforeTokens,
    afterTokens,
    reclaimedTokens,
    reclaimRatio: beforeTokens > 0 && reclaimedTokens > 0 ? reclaimedTokens / beforeTokens : 0,
    changed: messagesChanged(before, after),
  }
}

/**
 * Decide whether a candidate rewrite may replace history.
 *
 * - unchanged candidates never commit (nothing to gain, not even under force —
 *   committing them would still bump appendix baselines and compact markers);
 * - force=true (heap emergency / context ceiling / hard session split) commits
 *   any changed candidate regardless of floors, because the alternative is an
 *   OOM or an over-window API failure;
 * - otherwise the candidate must clear BOTH the absolute token floor and the
 *   relative ratio floor of the profile.
 */
/**
 * Structured record of one gate decision — the observability contract for
 * cache-log `event:'compact_decision'` rows (plan task 7). Emitted for both
 * committed and rejected candidates so "compressed but reclaimed nothing"
 * becomes visible offline instead of masquerading as a successful compact.
 */
export interface ReclaimDecisionRecord extends ReclaimEstimate {
  action: CompactionAction
  commit: boolean
  reason: ReclaimSkipReason | ReclaimCommitReason
  force: boolean
  windowBand: CompactionProfile['windowBand']
  billing: CompactionProfile['billing']
  cache: CompactionProfile['cache']
}

export function buildReclaimDecision(
  action: CompactionAction,
  estimate: ReclaimEstimate,
  profile: CompactionProfile,
  force: boolean,
): ReclaimDecisionRecord {
  const verdict = shouldCommitReclaim(estimate, profile, force)
  return {
    ...estimate,
    action,
    commit: verdict.commit,
    reason: verdict.reason,
    force,
    windowBand: profile.windowBand,
    billing: profile.billing,
    cache: profile.cache,
  }
}

export function shouldCommitReclaim(
  estimate: ReclaimEstimate,
  profile: CompactionProfile,
  force: boolean,
): ReclaimVerdict {
  if (!estimate.changed) return { commit: false, reason: 'unchanged' }
  if (force) return { commit: true, reason: 'forced' }
  if (estimate.reclaimedTokens <= 0) return { commit: false, reason: 'no-reclaim' }
  if (
    estimate.reclaimedTokens < profile.minReclaimTokens
    || estimate.reclaimRatio < profile.minReclaimRatio
  ) {
    return { commit: false, reason: 'below-reclaim-floor' }
  }
  return { commit: true, reason: 'reclaim-above-floor' }
}
