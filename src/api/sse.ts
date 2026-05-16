export interface SSEEvent {
  event: string
  data: string
  id?: string
}

export class SSEParser {
  private buffer = ''
  private eventBuffer = ''
  private dataBuffer = ''
  private idBuffer = ''
  private retryMs = 3000 // default per SSE spec

  getLastEventId(): string | undefined {
    return this.idBuffer || undefined
  }

  getRetryMs(): number {
    return this.retryMs
  }

  feed(chunk: string): SSEEvent[] {
    const events: SSEEvent[] = []
    this.buffer += chunk

    while (this.buffer.includes('\n')) {
      const idx = this.buffer.indexOf('\n')
      const line = this.buffer.slice(0, idx).replace(/\r$/, '')
      this.buffer = this.buffer.slice(idx + 1)

      if (line.startsWith('event:') || line.startsWith('event: ')) {
        this.eventBuffer = line.startsWith('event: ')
          ? line.slice(7)
          : line.slice(6).replace(/^[ \t]+/, '')
      } else if (line.startsWith('data:')) {
        // Handle both "data:value" and "data: value"
        const dataContent = line.slice(5).replace(/^[ \t]+/, '')
        if (dataContent) {
          this.dataBuffer += (this.dataBuffer ? '\n' : '') + dataContent
        }
      } else if (line.startsWith('id:')) {
        // id can contain null bytes, but we strip whitespace
        const id = line.slice(3).replace(/^[ \t]+/, '')
        if (id && !id.includes('\0')) {
          this.idBuffer = id
        }
      } else if (line.startsWith('retry:')) {
        const ms = parseInt(line.slice(6).trim(), 10)
        if (!isNaN(ms) && ms > 0) {
          this.retryMs = ms
        }
      } else if (line === '') {
        // Dispatch event
        if (this.dataBuffer) {
          events.push({
            event: this.eventBuffer || 'message',
            data: this.dataBuffer,
            id: this.idBuffer || undefined,
          })
          this.eventBuffer = ''
          this.dataBuffer = ''
          // id persists across events per spec
        }
      }
      // Lines starting with ':' are comments per spec — silently ignored
    }

    return events
  }

  reset(): void {
    this.buffer = ''
    this.eventBuffer = ''
    this.dataBuffer = ''
    this.idBuffer = ''
    // retryMs persists across resets per spec
  }
}
