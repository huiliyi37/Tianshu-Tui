/**
 * Which "waiting" indicator the live region should show.
 *
 * Before this gate, two indicators could render at once during first-token
 * wait: StreamOutput's empty-state "Waiting for model…" line AND the heartbeat
 * status box. As the heartbeat box appeared/updated below it, the live region
 * height oscillated and Ink under-erased the orphaned StreamOutput line, leaving
 * a growing stack of identical "Waiting for model…" rows (see resize-ghost
 * family — Ink erase-count vs rendered-height mismatch).
 *
 * The fix is to pick exactly ONE owner so the waiting state is a single,
 * height-stable element:
 *  - 'heartbeat' when a phase-derived status label exists (more informative —
 *    it carries the reason, e.g. "waiting for first token").
 *  - 'stream' as the generic fallback before any heartbeat label arrives.
 *  - 'none' when there's nothing to wait on (text/thinking/tools present, or
 *    not streaming).
 */
export type WaitingIndicator = 'stream' | 'heartbeat' | 'none'

export interface WaitingIndicatorInput {
  isStreaming: boolean
  hasText: boolean
  hasHeartbeat: boolean
  hasTools: boolean
  hasThinking: boolean
}

export function pickWaitingIndicator({
  isStreaming,
  hasText,
  hasHeartbeat,
  hasTools,
  hasThinking,
}: WaitingIndicatorInput): WaitingIndicator {
  // Any concrete live content (streamed text, running tools, thinking) means
  // we're no longer in a bare waiting state — let those own the screen.
  if (hasText || hasTools || hasThinking) return 'none'
  if (!isStreaming) return 'none'
  // Streaming, nothing yet: exactly one waiting indicator.
  return hasHeartbeat ? 'heartbeat' : 'stream'
}
