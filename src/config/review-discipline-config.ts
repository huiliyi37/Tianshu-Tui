/**
 * Review discipline feature flag.
 *
 * Controls whether deliverable commits are routed through the ReviewRouter before
 * being allowed through deliver_task. When enabled (default), code/config changes
 * must pass an independent adversarial review (L2/L3), while trivial docs/data
 * changes receive a non-blocking nudge (L1) before the commit proceeds.
 *
 * Disable with: RIVET_REVIEW_DISCIPLINE=0
 * Force on with:  RIVET_REVIEW_DISCIPLINE=1
 *
 * Default: disabled (false) — opt-in via RIVET_REVIEW_DISCIPLINE=1.
 *   Review worker timeout/failure was blocking the commit workflow too often.
 */

/**
 * Returns whether the review discipline gate is enabled.
 *
 * Reads the RIVET_REVIEW_DISCIPLINE env var:
 *   - "1" / "true" / "on" / "yes" → enabled
 *   - anything else (including unset) → disabled
 */
export function isReviewDisciplineEnabled(): boolean {
  const raw = process.env.RIVET_REVIEW_DISCIPLINE
  if (raw === undefined) return false
  const lower = raw.trim().toLowerCase()
  return lower === '1' || lower === 'true' || lower === 'on' || lower === 'yes'
}
