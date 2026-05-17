import type { StreamClient } from './stream-client.js'
import type { MessageRequest } from './types.js'
import type { StreamCallbacks } from './client.js'

export interface OpenAIClientConfig {
  baseUrl: string
  apiKey: string
  model: string
  maxTokens: number
}

interface OpenAIToolCall {
  id: string
  type: 'function'
  function: { name: string; arguments: string }
}

interface ToolCallChunk {
  index?: number
  id?: string
  type?: string
  function?: { name?: string; arguments?: string }
}

export class OpenAIClient implements StreamClient {
  private toolCallBuffer = new Map<number, { id?: string; type?: string; function: { name?: string; arguments: string } }>()

  constructor(private config: OpenAIClientConfig) {}

  async stream(
    request: MessageRequest,
    callbacks: StreamCallbacks,
    signal?: AbortSignal,
  ): Promise<void> {
    const body = this.buildRequestBody(request)
    const response = await fetch(`${this.config.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${this.config.apiKey}`,
      },
      body: JSON.stringify(body),
      signal,
    })

    if (!response.ok) {
      const errorBody = await response.text().catch(() => '')
      const msg = parseOpenAIError(response.status, errorBody)
      throw new Error(msg)
    }

    const reader = response.body?.getReader()
    if (!reader) throw new Error('Response body is not readable')

    await this.parseStreamFromReader(reader, callbacks, signal)
  }

  /** Convert Anthropic MessageRequest to OpenAI chat completions body */
  buildRequestBody(request: MessageRequest): Record<string, unknown> {
    const messages: Record<string, unknown>[] = []

    if (request.system) {
      const text = typeof request.system === 'string'
        ? request.system
        : request.system.map(b => b.text).join('')
      messages.push({ role: 'system', content: text })
    }

    for (const msg of request.messages) {
      if (msg.role === 'user') {
        const textParts: string[] = []
        const toolResults: Array<{ toolCallId: string; content: string }> = []

        const blocks = typeof msg.content === 'string'
          ? [{ type: 'text' as const, text: msg.content }]
          : msg.content

        for (const block of blocks) {
          if (block.type === 'text') {
            textParts.push(block.text)
          } else if (block.type === 'tool_result') {
            toolResults.push({
              toolCallId: block.tool_use_id,
              content: block.content,
            })
          }
        }

        if (textParts.length > 0) {
          messages.push({ role: 'user', content: textParts.join('') })
        }
        for (const tr of toolResults) {
          messages.push({
            role: 'tool',
            tool_call_id: tr.toolCallId,
            content: tr.content,
          })
        }
      } else if (msg.role === 'assistant') {
        const textParts: string[] = []
        const toolCalls: OpenAIToolCall[] = []

        const blocks = typeof msg.content === 'string'
          ? [{ type: 'text' as const, text: msg.content }]
          : msg.content

        for (const block of blocks) {
          if (block.type === 'text') {
            textParts.push(block.text)
          } else if (block.type === 'tool_use') {
            toolCalls.push({
              id: block.id,
              type: 'function',
              function: {
                name: block.name,
                arguments: JSON.stringify(block.input),
              },
            })
          }
        }

        const assistant: Record<string, unknown> = { role: 'assistant' }
        if (textParts.length > 0) {
          assistant.content = textParts.join('')
        }
        if (toolCalls.length > 0) {
          assistant.tool_calls = toolCalls
        }
        messages.push(assistant)
      }
    }

    return {
      model: this.config.model,
      messages,
      max_tokens: this.config.maxTokens,
      stream: true,
    }
  }

  /** Parse SSE stream from a reader — exposed for testing */
  async parseStreamFromReader(
    reader: ReadableStreamDefaultReader<Uint8Array>,
    callbacks: Partial<Pick<StreamCallbacks, 'onTextDelta' | 'onContentBlock' | 'onStopReason'>>,
    signal?: AbortSignal,
  ): Promise<void> {
    const decoder = new TextDecoder()
    let buffer = ''

    while (true) {
      if (signal?.aborted) throw new DOMException('Aborted', 'AbortError')

      const { done, value } = await reader.read()
      if (done) break

      buffer += decoder.decode(value, { stream: true })
      const lines = buffer.split('\n')
      buffer = lines.pop() ?? ''

      for (const line of lines) {
        const trimmed = line.trim()
        if (!trimmed || !trimmed.startsWith('data: ')) continue

        const payload = trimmed.slice(6)
        if (payload === '[DONE]') return

        try {
          const parsed = JSON.parse(payload)
          this.processDelta(parsed, callbacks)
        } catch {
          // Skip malformed SSE lines
        }
      }
    }

    this.flushToolCalls(callbacks)
  }

  /** Process a single SSE delta chunk — exposed for testing */
  processDelta(
    chunk: {
      choices: Array<{
        delta: { content?: string; tool_calls?: Array<ToolCallChunk> }
        finish_reason?: string | null
      }>
    },
    callbacks: Partial<Pick<StreamCallbacks, 'onTextDelta' | 'onContentBlock' | 'onStopReason'>>,
  ): void {
    const choice = chunk.choices?.[0]
    if (!choice) return

    const delta = choice.delta

    if (delta.content) {
      callbacks.onTextDelta?.(delta.content)
    }

    if (delta.tool_calls) {
      for (const tc of delta.tool_calls) {
        const idx = tc.index ?? 0
        const buf = this.toolCallBuffer.get(idx) ?? { function: { arguments: '' } }
        if (tc.id) buf.id = tc.id
        if (tc.type) buf.type = tc.type
        if (tc.function?.name) {
          buf.function.name = (buf.function.name ?? '') + tc.function.name
        }
        if (tc.function?.arguments) {
          buf.function.arguments += tc.function.arguments
        }
        this.toolCallBuffer.set(idx, buf)
      }
    }

    if (choice.finish_reason) {
      this.flushToolCalls(callbacks)
      callbacks.onStopReason?.(mapFinishReason(choice.finish_reason), {})
    }
  }

  private flushToolCalls(callbacks: Partial<Pick<StreamCallbacks, 'onContentBlock' | 'onStopReason'>>): void {
    for (const [, buf] of this.toolCallBuffer) {
      if (!buf.id || !buf.function.name) continue
      let input: Record<string, unknown> = {}
      try {
        input = JSON.parse(buf.function.arguments)
      } catch {
        input = {}
      }
      callbacks.onContentBlock?.({
        type: 'tool_use',
        id: buf.id,
        name: buf.function.name,
        input,
      })
    }
    this.toolCallBuffer.clear()
  }
}

function mapFinishReason(reason: string): string {
  switch (reason) {
    case 'stop': return 'end_turn'
    case 'tool_calls': return 'tool_use'
    case 'length': return 'max_tokens'
    default: return 'end_turn'
  }
}

export function parseOpenAIError(status: number, body: string): string {
  try {
    const parsed = JSON.parse(body)
    const code = parsed.error?.code ?? parsed.error?.type ?? `HTTP ${status}`
    const message = parsed.error?.message ?? body
    return `OpenAI API error (${code}): ${message}`
  } catch {
    return `OpenAI API error (HTTP ${status}): ${body}`
  }
}
