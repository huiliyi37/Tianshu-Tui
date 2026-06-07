/**
 * Turn-boundary abort cooperation.
 *
 * The agent loop's turn-boundary steps (postTurn hooks, compaction, prewarm,
 * perception) run as a chain of `await`s between a tool result and the next
 * model stream. The only abort-signal check sits at the very top of each loop
 * iteration, so if any of those awaits hangs (e.g. a postTurn hook awaiting a
 * promise that never resolves, an idle file read, an LLM compact with no
 * timeout), `abort()` only flips a flag that nobody re-reads until the (now
 * unreachable) next iteration. The UI freezes and Ctrl+C does nothing.
 *
 * `rejectOnAbort` races the in-flight work against the abort signal so that
 * aborting rejects immediately with an AbortError — which the loop's catch
 * already handles as a clean turn-end. The wedged promise is abandoned (it may
 * still resolve later into the void), but the loop is freed.
 */

/** AbortError thrown when the signal fires before `work` settles. */
export class TurnBoundaryAbortError extends Error {
  constructor(stage: string) {
    super(`Aborted during turn-boundary stage: ${stage}`)
    this.name = 'AbortError'
  }
}

/**
 * Race `work` against `signal`. Resolves/rejects with `work` if it settles
 * first; rejects with a (named 'AbortError') error the moment `signal` aborts.
 *
 * `stage` is a short label for diagnostics (which boundary step was wedged).
 */
export function rejectOnAbort<T>(
  work: Promise<T>,
  signal: AbortSignal | undefined,
  stage: string,
): Promise<T> {
  if (!signal) return work
  if (signal.aborted) return Promise.reject(new TurnBoundaryAbortError(stage))

  return new Promise<T>((resolve, reject) => {
    const onAbort = () => {
      cleanup()
      reject(new TurnBoundaryAbortError(stage))
    }
    const cleanup = () => signal.removeEventListener('abort', onAbort)
    signal.addEventListener('abort', onAbort, { once: true })
    work.then(
      value => { cleanup(); resolve(value) },
      err => { cleanup(); reject(err) },
    )
  })
}
