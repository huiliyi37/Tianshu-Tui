/**
 * Star-Soul runtime kill switch.
 *
 * Default: enabled. Set `STAR_SOUL=0` to disable star-soul runtime behavior
 * (courage-hook, star-domain routing).
 *
 * This is NOT an A/B experiment toggle — it's an emergency off switch.
 */

const ENV_KEY = 'STAR_SOUL'

/**
 * Returns true if the star-soul system is enabled.
 * Disabled only when STAR_SOUL env var is explicitly set to '0' or 'false'.
 */
export function isStarSoulEnabled(): boolean {
  const val = process.env[ENV_KEY]
  if (val === undefined) return true
  return val !== '0' && val.toLowerCase() !== 'false'
}
