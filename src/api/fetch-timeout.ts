/**
 * Fetch with pre-first-byte timeout.
 *
 * When the server accepts the TCP connection but never sends response headers,
 * a plain `fetch()` hangs indefinitely. This wrapper combines the caller's
 * AbortSignal with `AbortSignal.timeout()` so fetch always resolves/rejects
 * within `timeoutMs`.
 *
 * Error routing — critical for retry logic:
 * - User abort (signal.aborted) → re-throws original AbortError (non-retryable)
 * - Timeout → throws Error with "timed out" in message (retryable via error-classifier)
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
    // User abort — propagate as-is (retry engines treat AbortError as non-retryable)
    if (userSignal?.aborted) throw err
    // Timeout — throw descriptive error so error-classifier detects it
    if (timeoutSignal.aborted) {
      throw new Error(
        `Request timed out: server did not respond within ${Math.round(timeoutMs / 1000)} seconds`,
      )
    }
    throw err
  }
}
