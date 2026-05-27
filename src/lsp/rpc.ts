import { type Readable, type Writable } from 'node:stream'

interface JsonRpcRequest {
  jsonrpc: '2.0'
  id: number
  method: string
  params: Record<string, unknown>
}

interface JsonRpcResponse {
  jsonrpc: '2.0'
  id: number
  result?: unknown
  error?: { code: number; message: string; data?: unknown }
}

interface JsonRpcNotification {
  jsonrpc: '2.0'
  method: string
  params?: Record<string, unknown>
}

type JsonRpcMessage = JsonRpcRequest | JsonRpcResponse | JsonRpcNotification

export interface RpcClient {
  request(method: string, params: Record<string, unknown>): Promise<unknown>
  notify(method: string, params?: Record<string, unknown>): void
  onNotification(method: string, handler: (params: Record<string, unknown>) => void): void
  dispose(): void
}

export function encodeMessage(msg: JsonRpcMessage): string {
  const body = JSON.stringify(msg)
  return `Content-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`
}

const CRLFCRLF = Buffer.from('\r\n\r\n')

export function decodeMessages(input: string | Buffer): { messages: JsonRpcMessage[]; rest: string } {
  const messages: JsonRpcMessage[] = []
  const buf = Buffer.isBuffer(input) ? input : Buffer.from(input, 'utf8')
  let offset = 0

  while (true) {
    const headerEnd = buf.indexOf(CRLFCRLF, offset)
    if (headerEnd === -1) break

    const header = buf.subarray(offset, headerEnd).toString('utf8')
    const lengthMatch = /^Content-Length: (\d+)/m.exec(header)
    if (!lengthMatch) {
      offset = headerEnd + 4
      continue
    }

    const contentLength = parseInt(lengthMatch[1]!, 10)
    const bodyStart = headerEnd + 4
    if (buf.length - bodyStart < contentLength) break

    const body = buf.subarray(bodyStart, bodyStart + contentLength).toString('utf8')
    try {
      messages.push(JSON.parse(body) as JsonRpcMessage)
    } catch {
      // Skip malformed message
    }
    offset = bodyStart + contentLength
  }

  const rest = buf.subarray(offset).toString('utf8')
  return { messages, rest }
}

export function createRpcClient(readable: Readable, writable: Writable): RpcClient {
  let nextId = 1
  const pending = new Map<number, { resolve(v: unknown): void; reject(e: Error): void }>()
  const notificationHandlers = new Map<string, Array<(params: Record<string, unknown>) => void>>()
  let buffer = Buffer.alloc(0)

  readable.on('data', (chunk: Buffer) => {
    buffer = Buffer.concat([buffer, chunk])
    const { messages, rest } = decodeMessages(buffer)
    buffer = Buffer.from(rest, 'utf8')

    for (const msg of messages) {
      if ('id' in msg && 'result' in msg && !('method' in msg)) {
        const p = pending.get(msg.id)
        if (p) {
          pending.delete(msg.id)
          p.resolve(msg.result)
        }
      } else if ('id' in msg && 'error' in msg && !('method' in msg)) {
        const p = pending.get(msg.id)
        if (p) {
          pending.delete(msg.id)
          p.reject(new Error(msg.error!.message))
        }
      } else if ('method' in msg && !('id' in msg)) {
        const handlers = notificationHandlers.get(msg.method)
        if (handlers) {
          for (const h of handlers) h((msg as JsonRpcNotification).params ?? {})
        }
      }
    }
  })

  return {
    request(method, params) {
      return new Promise((resolve, reject) => {
        const id = nextId++
        pending.set(id, { resolve, reject })
        const msg: JsonRpcRequest = { jsonrpc: '2.0', id, method, params }
        writable.write(encodeMessage(msg))
      })
    },
    notify(method, params) {
      const msg: JsonRpcNotification = {
        jsonrpc: '2.0' as const,
        method,
        params,
      }
      writable.write(encodeMessage(msg))
    },
    onNotification(method, handler) {
      const existing = notificationHandlers.get(method)
      if (existing) {
        existing.push(handler)
      } else {
        notificationHandlers.set(method, [handler])
      }
    },
    dispose() {
      pending.clear()
      notificationHandlers.clear()
      readable.removeAllListeners('data')
    },
  }
}
