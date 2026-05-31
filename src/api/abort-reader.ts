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
