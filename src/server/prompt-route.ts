import type { ServerResponse } from 'node:http'
import type { RouteHandler } from './index.js'
import { SseStream } from './sse-stream.js'

export interface PromptRouteDeps {
  createAgent: () => {
    run: (prompt: string, callbacks: Record<string, unknown>) => Promise<void>
    abort: () => void
  }
}

export function buildPromptHandler(_deps: PromptRouteDeps): RouteHandler {
  return async (body: unknown) => {
    const data = body as { prompt?: string }
    if (!data?.prompt || typeof data.prompt !== 'string' || !data.prompt.trim()) {
      return { status: 400, body: { error: 'Missing or empty "prompt" field' } }
    }

    return {
      status: 200,
      body: { accepted: true, prompt: data.prompt },
    }
  }
}

export function handlePromptSSE(deps: PromptRouteDeps, res: ServerResponse, prompt: string): void {
  const sse = new SseStream(res)
  const agent = deps.createAgent()

  agent.run(prompt, {
    onTextDelta: (delta: string) => {
      sse.send('text_delta', { text: delta })
    },
    onThinkingDelta: () => {},
    onToolUse: (id: string, name: string, input: Record<string, unknown>) => {
      sse.send('tool_use', { id, name, input })
    },
    onToolResult: (id: string, name: string, result: string, isError?: boolean) => {
      sse.send('tool_result', { id, name, isError: !!isError, result: result.slice(0, 500) })
    },
    onTurnComplete: (usage: unknown) => {
      sse.send('turn_complete', { usage })
    },
    onError: (err: Error) => {
      sse.send('error', { error: err.message })
      sse.close()
    },
    onAbort: () => {
      sse.send('done', {})
      sse.close()
    },
    onApprovalRequired: async () => false,
  }).then(() => {
    sse.close()
  })
}
