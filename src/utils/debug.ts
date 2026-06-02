/**
 * Debug logging utility
 *
 * Controlled by RIVET_DEBUG environment variable:
 * - RIVET_DEBUG=1 or RIVET_DEBUG=true → debug logging enabled
 * - Otherwise → debug logging disabled
 */

const isDebugEnabled = (): boolean => {
  const flag = process.env.RIVET_DEBUG?.toLowerCase()
  return flag === '1' || flag === 'true'
}

/**
 * Log debug messages to stderr (only when RIVET_DEBUG is enabled)
 * Use for operational diagnostics like token-gate, persist, artifact-intercept
 */
export const debugLog = (...args: unknown[]): void => {
  if (isDebugEnabled()) {
    const ts = new Date().toISOString().slice(11, 19)
    console.warn(`[${ts}]`, ...args)
  }
}

/**
 * Check if debug mode is active
 */
export const debugEnabled = (): boolean => isDebugEnabled()
