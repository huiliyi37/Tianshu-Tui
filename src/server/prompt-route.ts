/**
 * Legacy one-shot prompt endpoint (M0): POST /prompt streams a single run as
 * SSE on the request itself.
 *
 * Since the /sessions rebase, this is a thin veneer over the session manager —
 * the run executes on a real (persisted) session, so BOTH paths share one
 * execution model and one disconnect semantic: a dropped connection never
 * aborts the run. The stream opens with a `session` event carrying the session
 * id; a disconnected client can re-attach via `GET /sessions/:id/events?since=`
 * or stop the run explicitly via `POST /sessions/:id/abort`. (Historically this
 * path aborted on disconnect — the opposite of /sessions — which made the API
 * a trap for consumers moving between the two.)
 *
 * Redaction happens upstream in the session manager (the same events feed the
 * /sessions stream), so nothing here re-scrubs payloads.
 */
import type { ServerResponse } from 'node:http'
import type { RouteHandler } from './index.js'
import { SseStream } from './sse-stream.js'

/** A session event as forwarded to the legacy SSE wire. */
export interface PromptSessionEvent {
  type: string
  data: Record<string, unknown>
}

export interface PromptRouteDeps {
  /**
   * Create a fresh session for a one-shot prompt. Returns null when a session
   * cannot be created. `subscribe` must be called before `start` so no event
   * of the run is missed; `start` returns false when the run refused to start.
   */
  startPrompt: (prompt: string) => {
    sessionId: string
    subscribe: (listener: (ev: PromptSessionEvent) => void) => (() => void) | undefined
    start: () => boolean
  } | null
}

/** Session event types forwarded on the legacy wire (same names both sides). */
const FORWARDED_TYPES = new Set(['text_delta', 'tool_use', 'tool_result', 'turn_complete', 'error'])

export function buildPromptHandler(deps: PromptRouteDeps): RouteHandler {
  return async (body: unknown, _params, _headers, res) => {
    const data = body as { prompt?: string }
    if (!data?.prompt || typeof data.prompt !== 'string' || !data.prompt.trim()) {
      return { status: 400, body: { error: 'Missing or empty "prompt" field' } }
    }
    if (!res) {
      return { status: 500, body: { error: 'SSE response stream is unavailable' } }
    }

    handlePromptSSE(deps, res, data.prompt)
    return { status: 200, handled: true }
  }
}

export function handlePromptSSE(deps: PromptRouteDeps, res: ServerResponse, prompt: string): void {
  const started = deps.startPrompt(prompt)
  const sse = new SseStream(res)
  if (!started) {
    sse.send('error', { error: 'Failed to create a session for this prompt' })
    sse.close()
    return
  }

  let closed = false
  let unsubscribe: (() => void) | undefined

  const detach = () => {
    if (closed) return
    closed = true
    res.removeListener('close', onClientClose)
    unsubscribe?.()
  }
  const onClientClose = () => {
    // Client went away: stop streaming, but do NOT abort — identical to the
    // /sessions stream. The run continues and its events persist on the
    // session; the `session` event below told the client where to find them.
    detach()
  }
  const close = () => {
    detach()
    if (res.destroyed || res.writableEnded) return
    sse.close() // emits the terminal `done` frame
  }

  res.on('close', onClientClose)

  // First frame: where this run lives, for re-attach / explicit abort.
  sse.send('session', { sessionId: started.sessionId })

  unsubscribe = started.subscribe((ev) => {
    if (closed) return
    if (FORWARDED_TYPES.has(ev.type)) {
      sse.send(ev.type, ev.data)
    } else if (ev.type === 'done') {
      close()
    }
  })
  if (!unsubscribe) {
    sse.send('error', { error: 'Session disappeared before streaming began' })
    close()
    return
  }

  if (!started.start()) {
    sse.send('error', { error: 'Session is missing or already running' })
    close()
  }
}
