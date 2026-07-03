/**
 * Fetch with pre-first-byte timeout.
 *
 * When the server accepts the TCP connection but never sends response headers,
 * a plain `fetch()` hangs indefinitely. This wrapper arms a timeout that
 * aborts the request if response HEADERS have not arrived within `timeoutMs`.
 *
 * CRITICAL — the timeout is disarmed the moment fetch resolves (headers
 * received). It must NOT stay armed during body streaming: a long healthy SSE
 * stream (e.g. a multi-minute reasoning response) would otherwise be cut off
 * mid-body with a raw `TimeoutError` ("The operation was aborted due to
 * timeout") once total request duration exceeds the first-byte budget.
 * Mid-body stream health is the responsibility of the SSE parsers' layered
 * guards (idle/read timers, thinking-stall, progress-extended hard cap) —
 * see the 4e1aaa21 post-mortem (2026-07-02).
 *
 * Error routing — critical for retry logic:
 * - Pre-first-byte timeout → throws descriptive Error (retryable)
 * - AbortError (user-initiated AbortController.abort) → re-throws as-is (non-retryable)
 * - Other → re-throws original error
 */

const DEFAULT_TIMEOUT_MS = 45_000

export async function fetchWithTimeout(
  url: string | URL,
  init: RequestInit,
  timeoutMs: number = DEFAULT_TIMEOUT_MS,
): Promise<Response> {
  const userSignal = init.signal
  // Own controller + timer instead of AbortSignal.timeout: AbortSignal.timeout
  // cannot be disarmed, so merging it into the fetch signal would keep counting
  // down through the entire body stream. A clearable timer lets us cover only
  // the pre-headers window.
  const timeoutController = new AbortController()
  let timedOut = false
  const timer = setTimeout(() => {
    timedOut = true
    timeoutController.abort()
  }, timeoutMs)

  const combinedSignal = userSignal
    ? AbortSignal.any([userSignal, timeoutController.signal])
    : timeoutController.signal

  try {
    return await fetch(url, { ...init, signal: combinedSignal })
  } catch (err) {
    const name = (err as Error).name
    // Our pre-first-byte timeout fired. Always wrap with a descriptive message
    // so error-classifier detects it as a retryable timeout.
    if (timedOut || name === 'TimeoutError') {
      throw new Error(
        `Request timed out: server did not respond within ${Math.round(timeoutMs / 1000)} seconds`,
      )
    }
    // AbortError: user-initiated cancellation — propagate as-is (non-retryable)
    if (name === 'AbortError' || userSignal?.aborted) throw err
    throw err
  } finally {
    // Headers arrived (or fetch failed) — disarm. Body streaming continues
    // under the caller's own signal, unaffected by this timeout.
    clearTimeout(timer)
  }
}
