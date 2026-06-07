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
 * Default: enabled (true).
 */

/**
 * Returns whether the review discipline gate is enabled.
 *
 * Reads the RIVET_REVIEW_DISCIPLINE env var:
 *   - "0" / "false" / "off" / "no" → disabled
 *   - anything else (including unset) → enabled
 */
export function isReviewDisciplineEnabled(): boolean {
  const raw = process.env.RIVET_REVIEW_DISCIPLINE
  if (raw === undefined) return true
  const lower = raw.trim().toLowerCase()
  return !(lower === '0' || lower === 'false' || lower === 'off' || lower === 'no')
}
