/**
 * Review discipline feature flag.
 *
 * Controls whether fix commits are routed through the ReviewRouter before
 * being allowed through deliver_task. When enabled (default), fix commits
 * must pass an independent adversarial review (L2/L3) or receive a nudge
 * (L1) before the commit proceeds.
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
