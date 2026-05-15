export interface SSEEvent {
  event: string
  data: string
}

export class SSEParser {
  private buffer = ''
  private eventBuffer = ''
  private dataBuffer = ''

  feed(chunk: string): SSEEvent[] {
    const events: SSEEvent[] = []
    this.buffer += chunk

    while (this.buffer.includes('\n')) {
      const idx = this.buffer.indexOf('\n')
      const line = this.buffer.slice(0, idx).replace(/\r$/, '')
      this.buffer = this.buffer.slice(idx + 1)

      if (line.startsWith('event: ')) {
        this.eventBuffer = line.slice(7)
      } else if (line.startsWith('data:')) {
        // Handle both "data:value" and "data: value"
        const dataContent = line.slice(5).replace(/^[ \t]+/, '')
        if (dataContent) {
          this.dataBuffer += (this.dataBuffer ? '\n' : '') + dataContent
        }
      } else if (line === '') {
        if (this.dataBuffer) {
          events.push({
            event: this.eventBuffer || 'message',
            data: this.dataBuffer,
          })
          this.eventBuffer = ''
          this.dataBuffer = ''
        }
      }
    }

    return events
  }

  reset(): void {
    this.buffer = ''
    this.eventBuffer = ''
    this.dataBuffer = ''
  }
}
