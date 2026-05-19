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

/**
 * Returns true if the star-soul system is enabled.
 * Disabled only when STAR_SOUL env var is explicitly set to '0' or 'false'.
 */
export function isStarSoulEnabled(): boolean {
  const val = process.env[ENV_KEY]
  if (val === undefined) return true // default: enabled
  return val !== '0' && val.toLowerCase() !== 'false'
}
