/**
 * Fetch with pre-first-byte timeout.
 *
 * When the server accepts the TCP connection but never sends response headers,
 * a plain `fetch()` hangs indefinitely. This wrapper combines the caller's
 * AbortSignal with `AbortSignal.timeout()` so fetch always resolves/rejects
 * within `timeoutMs`.
 *
 * Error routing — critical for retry logic:
 * - TimeoutError (any AbortSignal.timeout) → throws descriptive Error (retryable)
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
  const timeoutSignal = AbortSignal.timeout(timeoutMs)
  const combinedSignal = userSignal
    ? AbortSignal.any([userSignal, timeoutSignal])
    : timeoutSignal

  try {
    return await fetch(url, { ...init, signal: combinedSignal })
  } catch (err) {
    const name = (err as Error).name
    // TimeoutError: any AbortSignal.timeout fired (ours or caller's).
    // Always wrap with a descriptive message so error-classifier detects it.
    if (name === 'TimeoutError' || timeoutSignal.aborted) {
      throw new Error(
        `Request timed out: server did not respond within ${Math.round(timeoutMs / 1000)} seconds`,
      )
    }
    // AbortError: user-initiated cancellation — propagate as-is (non-retryable)
    if (name === 'AbortError' || userSignal?.aborted) throw err
    throw err
  }
}
