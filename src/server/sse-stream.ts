import type { ServerResponse } from 'node:http'

export class SseStream {
  private res: ServerResponse

  constructor(res: ServerResponse) {
    this.res = res
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
    })
  }

  send(event: string, data: unknown): void {
    this.res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`)
  }

  close(): void {
    this.send('done', {})
    this.res.end()
  }
}
