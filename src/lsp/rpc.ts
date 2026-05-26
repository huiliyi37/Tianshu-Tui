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

export function decodeMessages(buffer: string): { messages: JsonRpcMessage[]; rest: string } {
  const messages: JsonRpcMessage[] = []
  let rest = buffer

  while (true) {
    const headerEnd = rest.indexOf('\r\n\r\n')
    if (headerEnd === -1) break

    const header = rest.slice(0, headerEnd)
    const lengthMatch = /^Content-Length: (\d+)/m.exec(header)
    if (!lengthMatch) {
      rest = rest.slice(headerEnd + 4)
      continue
    }

    const contentLength = parseInt(lengthMatch[1]!, 10)
    const bodyStart = headerEnd + 4
    if (rest.length < bodyStart + contentLength) break

    const body = rest.slice(bodyStart, bodyStart + contentLength)
    try {
      messages.push(JSON.parse(body) as JsonRpcMessage)
    } catch {
      // Skip malformed message
    }
    rest = rest.slice(bodyStart + contentLength)
  }

  return { messages, rest }
}

export function createRpcClient(readable: Readable, writable: Writable): RpcClient {
  let nextId = 1
  const pending = new Map<number, { resolve(v: unknown): void; reject(e: Error): void }>()
  const notificationHandlers = new Map<string, Array<(params: Record<string, unknown>) => void>>()
  let buffer = ''

  readable.on('data', (chunk: Buffer) => {
    buffer += chunk.toString()
    const { messages, rest } = decodeMessages(buffer)
    buffer = rest

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
