import type { ServerResponse } from 'node:http'
import type { AgentCallbacks } from '../agent/loop.js'
import type { RouteHandler } from './index.js'
import { SseStream } from './sse-stream.js'

const REDACTED = '[REDACTED]'
const SENSITIVE_KEY = /(?:api[_-]?key|token|secret|password|authorization)/i

export interface PromptRouteDeps {
  createAgent: () => {
    run: (prompt: string, callbacks: AgentCallbacks) => Promise<void>
    abort: () => void
  }
}

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
  const sse = new SseStream(res)
  const agent = deps.createAgent()
  let closed = false

  const send = (event: string, data: unknown) => {
    if (closed || res.destroyed || res.writableEnded) return
    sse.send(event, data)
  }
  const onClientClose = () => {
    if (closed) return
    closed = true
    res.removeListener('close', onClientClose)
    agent.abort()
  }
  const close = () => {
    if (closed) return
    closed = true
    res.removeListener('close', onClientClose)
    if (res.destroyed || res.writableEnded) return
    sse.close()
  }

  res.on('close', onClientClose)

  void agent.run(prompt, {
    onTextDelta: (delta) => {
      send('text_delta', { text: delta })
    },
    onThinkingDelta: () => {},
    onToolUse: (id, name, input) => {
      send('tool_use', { id, name, input: redactValue(input) })
    },
    onToolResult: (id, name, result, isError, _rawPath, uiContent) => {
      send('tool_result', { id, name, isError: !!isError, result: redactText(result).slice(0, 500), ...(uiContent ? { uiContent: redactText(uiContent).slice(0, 500) } : {}) })
    },
    onTurnComplete: (usage, turnNumber, isFinal, evidenceSummary) => {
      send('turn_complete', { usage, turnNumber, isFinal: !!isFinal, ...(isFinal && evidenceSummary ? { evidence: evidenceSummary } : {}) })
    },
    onError: (err) => {
      send('error', { error: redactText(err.message) })
      close()
    },
    onAbort: () => {
      close()
    },
    onApprovalRequired: async () => false,
  }).then(() => {
    close()
  }).catch((err: Error) => {
    // Agent.run rejected outside the onError callback path
    // (e.g. unexpected crash, unhandled exception in setup).
    send('error', { error: redactText(err.message) })
    close()
  }).finally(() => {
    res.removeListener('close', onClientClose)
  })
}

function redactValue(value: unknown): unknown {
  if (typeof value === 'string') return redactText(value)
  if (Array.isArray(value)) return value.map(redactValue)
  if (!value || typeof value !== 'object') return value
  if (value instanceof Date) return value.toISOString()

  const redacted: Record<string, unknown> = {}
  for (const [key, child] of Object.entries(value)) {
    redacted[key] = SENSITIVE_KEY.test(key) ? REDACTED : redactValue(child)
  }
  return redacted
}

function redactText(text: string): string {
  return text
    .replace(/(Bearer\s+)[A-Za-z0-9._~+/=-]+/gi, `$1${REDACTED}`)
    .replace(/((?:api[_-]?key|token|secret|password)\s*[:=]\s*)[^\s,'\"]+/gi, `$1${REDACTED}`)
}
