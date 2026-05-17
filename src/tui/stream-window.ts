const LIVE_STREAM_TRUNCATION_MARKER = '… truncated live stream output …\n'

export function appendStreamWindow(current: string, next: string, maxChars: number): string {
  const combined = current + next
  if (combined.length <= maxChars) return combined
  return LIVE_STREAM_TRUNCATION_MARKER + combined.slice(-maxChars)
}
