import { rivetFetch } from './client'
import type { SessionEvent } from './types'

/**
 * Consume a session's live SSE stream via fetch + ReadableStream. EventSource
 * cannot set an Authorization header, so we read the body stream manually and
 * parse `event:`/`data:` frames. The server replays everything after `since`
 * then streams live (see src/server/session-routes.ts GET /stream).
 *
 * Resolves when the stream ends (server closed / aborted); rejects on network
 * error. Honors the AbortSignal for clean teardown on unmount.
 */
/**
 * Liveness watchdog. The server sends a `: ping` comment every 30s; if no bytes
 * (data OR heartbeat) arrive for this long, the socket is presumed half-dead
 * (sleep/wake, NAT/Wi-Fi drop — TCP can stall without ever delivering a FIN, so
 * `reader.read()` would otherwise hang forever and the UI would sit on a stale
 * "live" thread). We then abort + throw so the caller reconnects (resuming from
 * the last seq). 90s ≈ 3 missed beats — long enough to tolerate a slow turn.
 */
const DEFAULT_IDLE_TIMEOUT_MS = 90_000

export async function streamSession(
  id: string,
  since: number,
  onEvent: (event: SessionEvent) => void,
  signal: AbortSignal,
  onOpen?: () => void,
  idleTimeoutMs: number = DEFAULT_IDLE_TIMEOUT_MS,
): Promise<void> {
  // Internal controller so the idle watchdog can tear down the fetch without
  // touching the caller's signal. Linked to the caller's signal so an unmount
  // still aborts the underlying request.
  const ac = new AbortController()
  const onExternalAbort = () => ac.abort()
  if (signal.aborted) ac.abort()
  else signal.addEventListener('abort', onExternalAbort, { once: true })

  try {
    const res = await rivetFetch(`/sessions/${id}/stream?since=${since}`, { signal: ac.signal })
    if (!res.ok || !res.body) throw new Error(`stream ${id} -> ${res.status}`)

    // Connection established: the server accepted the request and handed back a
    // live body. Signal "live" here rather than on the first data frame, because
    // a caught-up idle session only emits `: ping` heartbeat comments (no data
    // event) until the next run — waiting for an event would leave a healthy
    // stream stuck showing "connecting".
    onOpen?.()

    const reader = res.body.getReader()
    const decoder = new TextDecoder()
    let buf = ''

    try {
      for (;;) {
        // Race the read against the idle deadline. A pending read after a timeout
        // is orphaned; ac.abort() settles it and the pre-attached catch swallows
        // its (now-irrelevant) rejection so it never surfaces as unhandled.
        let timer: ReturnType<typeof setTimeout> | undefined
        const readP = reader.read()
        readP.catch(() => {})
        let result: ReadableStreamReadResult<Uint8Array>
        try {
          result = await Promise.race([
            readP,
            new Promise<never>((_, reject) => {
              timer = setTimeout(() => {
                ac.abort()
                reject(new Error(`stream ${id} idle > ${idleTimeoutMs}ms`))
              }, idleTimeoutMs)
            }),
          ])
        } finally {
          if (timer) clearTimeout(timer)
        }

        const { done, value } = result
        if (done) break
        buf += decoder.decode(value, { stream: true })

        let idx: number
        while ((idx = buf.indexOf('\n\n')) >= 0) {
          const frame = buf.slice(0, idx)
          buf = buf.slice(idx + 2)
          const event = parseFrame(frame)
          if (event) onEvent(event)
        }
      }
      // Flush the decoder (release any held trailing multi-byte sequence) and the
      // residual buffer: a server that closes without a final blank-line separator
      // would otherwise silently drop its last event.
      buf += decoder.decode()
      if (buf.trim()) {
        const event = parseFrame(buf)
        if (event) onEvent(event)
      }
    } finally {
      // After an idle/abort a read may still be outstanding, which makes
      // releaseLock throw — harmless here (the stream is being torn down), so
      // swallow it rather than masking the real error.
      try {
        reader.releaseLock()
      } catch {
        /* outstanding read after abort */
      }
    }
  } finally {
    signal.removeEventListener('abort', onExternalAbort)
  }
}

function parseFrame(frame: string): SessionEvent | null {
  // SSE allows an event to carry multiple `data:` lines; the payload is their
  // values joined with '\n' (per spec). The server currently emits a single
  // data line, but joining keeps us correct if a frame ever arrives split
  // across lines (large value, future server change, or a CRLF proxy).
  const dataLines: string[] = []
  for (const rawLine of frame.split('\n')) {
    // Tolerate CRLF: strip a trailing '\r' the line-split left behind.
    const line = rawLine.endsWith('\r') ? rawLine.slice(0, -1) : rawLine
    if (line.startsWith('data:')) {
      // Drop the field name and a single optional leading space (per spec).
      dataLines.push(line.slice(5).replace(/^ /, ''))
    }
  }
  if (dataLines.length === 0) return null
  const payload = dataLines.join('\n').trim()
  if (!payload) return null
  try {
    const parsed = JSON.parse(payload)
    // The server sends the full SessionEvent ({ seq, ts, type, data }) as data.
    if (parsed && typeof parsed.seq === 'number' && typeof parsed.type === 'string') {
      return parsed as SessionEvent
    }
    return null
  } catch {
    return null
  }
}
