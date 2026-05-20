/**
 * Star-Soul A/B Gate — single toggle for the entire star-soul system.
 *
 * When `STAR_SOUL=0` is set in the environment, all three components
 * (beliefs constitution, courage-hook, star-domain injection) are disabled.
 * This allows A/B testing without branch switching.
 *
 * Usage:
 *   STAR_SOUL=0 node dist/main.js   # Environment A (control)
 *   STAR_SOUL=1 node dist/main.js   # Environment B (experiment)
 *   node dist/main.js               # Defaults to enabled
 */

const ENV_KEY = 'STAR_SOUL'
const ACTIVATION_WINDOW = 5
const ACTIVATION_THRESHOLD = 0.7

/**
 * Returns true if the star-soul system is enabled.
 * Disabled only when STAR_SOUL env var is explicitly set to '0' or 'false'.
 */
export function isStarSoulEnabled(): boolean {
  const val = process.env[ENV_KEY]
  if (val === undefined) return true // default: enabled
  return val !== '0' && val.toLowerCase() !== 'false'
}

/**
 * Emergence activation — star-soul unlocks when confidence stays high.
 *
 * Returns true when:
 * - STAR_SOUL=1 (manual override), OR
 * - STAR_SOUL is unset AND confidence >= 0.7 for the last 5 consecutive turns
 *
 * Returns false when:
 * - STAR_SOUL=0 (manual disable), OR
 * - confidence history is too short, OR
 * - any recent turn dropped below threshold
 */
export function shouldActivateStarSoul(confidenceHistory: number[]): boolean {
  const val = process.env[ENV_KEY]
  if (val === '0' || val?.toLowerCase() === 'false') return false
  if (val === '1' || val?.toLowerCase() === 'true') return true

  if (confidenceHistory.length < ACTIVATION_WINDOW) return false
  const recent = confidenceHistory.slice(-ACTIVATION_WINDOW)
  return recent.every(c => c >= ACTIVATION_THRESHOLD)
}
