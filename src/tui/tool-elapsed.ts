/**
 * Format tool runtime for the streaming tool card.
 * Returns empty string under 1 second to avoid noise on fast tools.
 */
export function formatToolElapsed(ms: number): string {
  if (ms < 1000) return ''
  const s = Math.floor(ms / 1000)
  if (s < 60) return `${s}s`
  return `${Math.floor(s / 60)}m${String(s % 60).padStart(2, '0')}s`
}
