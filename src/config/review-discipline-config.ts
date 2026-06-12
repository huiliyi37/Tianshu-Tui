/**
 * Review discipline feature flag.
 *
 * Controls whether deliverable commits are routed through the ReviewRouter
 * before being allowed through deliver_task.
 *
 * Modes (see review-router.ts):
 *   - auto (no review_level): ONE wiring-effectiveness inspector on a short
 *     budget. Infra failures/timeouts NEVER block the delivery (fail-open
 *     with caveat); only CRITICAL/HIGH findings block.
 *   - manual (/review → L2, /review max → L3): full adversarial verifier or
 *     5-inspector squadron with profile-derived budgets.
 *
 * Default: ENABLED. It was temporarily default-off because review worker
 * timeouts used to hard-block the commit workflow (fixed 90s cap killed
 * workers mid-flight and the failure was fail-closed). Both root causes are
 * fixed: budgets are profile-aligned and the auto path is fail-open.
 *
 * Disable with: RIVET_REVIEW_DISCIPLINE=0
 */

/**
 * Returns whether the review discipline gate is enabled.
 *
 * Reads the RIVET_REVIEW_DISCIPLINE env var:
 *   - "0" / "false" / "off" / "no" → disabled
 *   - anything else (including unset) → enabled (default)
 */
export function isReviewDisciplineEnabled(): boolean {
  const raw = process.env.RIVET_REVIEW_DISCIPLINE
  if (raw === undefined) return true
  const lower = raw.trim().toLowerCase()
  return !(lower === '0' || lower === 'false' || lower === 'off' || lower === 'no')
}
