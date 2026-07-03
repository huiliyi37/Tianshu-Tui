/**
 * Wire an external AbortSignal to a ReadableStream reader so that aborting
 * the signal immediately cancels the reader.  This unblocks any pending
 * reader.read() call, preventing the deadlock where signal.aborted is true
 * but the stream loop is stuck waiting for the next SSE chunk.
 *
 * Returns a cleanup function that removes the event listener.
 *
 * Used by all SSE stream parsers (OpenAIClient, AnthropicClient, CodexClient).
 */
export function wireAbortToReaderCancel(
  signal: AbortSignal,
  reader: ReadableStreamDefaultReader<unknown>,
): () => void {
  const onAbort = () => reader.cancel().catch(() => {})
  if (signal.aborted) {
    // Already aborted — cancel immediately (don't add listener for a past event)
    reader.cancel().catch(() => {})
    return () => {}
  }
  signal.addEventListener('abort', onAbort, { once: true })
  return () => signal.removeEventListener('abort', onAbort)
}

/**
 * Wrap a body-phase `TimeoutError` DOMException in a descriptive, classifiable
 * Error. Defense-in-depth after the 4e1aaa21 post-mortem: if any timeout
 * AbortSignal ever aborts the fetch mid-body again, `reader.read()` rejects
 * with the raw undici message "The operation was aborted due to timeout",
 * which surfaced verbatim in the TUI and gave zero context. This wrapper
 * keeps "timed out" in the message (error-classifier → retryable timeout)
 * and records provider + elapsed streaming time.
 *
 * User-initiated AbortError and everything else pass through unchanged.
 */
export function wrapBodyTimeoutError(
  err: unknown,
  provider: string,
  streamStartedAt: number,
): unknown {
  const name = (err as { name?: string } | null)?.name
  if (name !== 'TimeoutError') return err
  const secs = Math.round((Date.now() - streamStartedAt) / 1000)
  return new Error(
    `${provider} SSE stream timed out mid-body after ${secs}s of streaming — ` +
    `a timeout signal aborted the request while the body was still being read`,
  )
}
