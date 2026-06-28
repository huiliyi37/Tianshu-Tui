import type { ServerResponse } from 'node:http'

export class SseStream {
  private res: ServerResponse
  private _closed = false

  constructor(res: ServerResponse) {
    this.res = res
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
      // CORS: the SSE response takes over `res` (handled:true), bypassing the
      // router's header logic in index.ts — so it must set the same
      // Access-Control-Allow-Origin the REST responses do. Without it, the
      // Tauri webview (origin tauri://localhost, cross-origin to 127.0.0.1:<port>)
      // blocks the stream and the client loops forever on "reconnecting" while
      // plain GETs (which DO get CORS via the router) keep working.
      'Access-Control-Allow-Origin': '*',
    })
  }

  send(event: string, data: unknown): void {
    if (this._closed) return
    // A peer that has already gone away makes `res.write` throw (EPIPE/
    // ERR_STREAM_DESTROYED). Treat that as a close rather than crashing the
    // server: a dead viewer must never take down the process.
    try {
      this.res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`)
    } catch {
      this._closed = true
    }
  }

  /**
   * Heartbeat as an SSE comment line (`: ...`). EventSource clients silently
   * ignore comments, but the byte keeps intermediaries (proxies, load
   * balancers) from reaping an otherwise idle connection — and surfaces a dead
   * socket so we can stop the keepalive timer.
   */
  ping(): void {
    if (this._closed) return
    try {
      this.res.write(': ping\n\n')
    } catch {
      this._closed = true
    }
  }

  /** True once the stream has been closed (locally or by a dead peer). */
  isClosed(): boolean {
    return this._closed
  }

  close(): void {
    if (this._closed) return
    this._closed = true
    try {
      this.res.write('event: done\ndata: {}\n\n')
    } catch {
      // socket already gone — nothing to flush
    }
    try {
      this.res.end()
    } catch {
      // response already ended
    }
  }
}
