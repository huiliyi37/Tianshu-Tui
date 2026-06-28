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
export async function streamSession(
  id: string,
  since: number,
  onEvent: (event: SessionEvent) => void,
  signal: AbortSignal,
  onOpen?: () => void,
): Promise<void> {
  const res = await rivetFetch(`/sessions/${id}/stream?since=${since}`, { signal })
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
      const { done, value } = await reader.read()
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
  } finally {
    reader.releaseLock()
  }
}

function parseFrame(frame: string): SessionEvent | null {
  let dataLine: string | null = null
  for (const line of frame.split('\n')) {
    if (line.startsWith('data:')) dataLine = line.slice(5).trim()
  }
  if (!dataLine) return null
  try {
    const parsed = JSON.parse(dataLine)
    // The server sends the full SessionEvent ({ seq, ts, type, data }) as data.
    if (parsed && typeof parsed.seq === 'number' && typeof parsed.type === 'string') {
      return parsed as SessionEvent
    }
    return null
  } catch {
    return null
  }
}
