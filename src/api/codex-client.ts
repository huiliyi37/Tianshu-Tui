import type { StreamClient } from './stream-client.js'
import type { MessageRequest, ContentBlock } from './types.js'
import type { StreamCallbacks } from './client.js'

export interface CodexClientConfig {
  baseUrl: string
  model: string
  maxTokens: number
  auth?: import('../auth/types.js').AuthProvider
}

const CODEX_USER_AGENT = 'codex_cli_rs/0.118.0 (Mac OS 26.3.1; arm64) iTerm.app/3.6.9'
const CODEX_ORIGINATOR = 'codex_cli_rs'
const MAX_RETRIES = 3
const BASE_DELAY_MS = 1000

export class CodexClient implements StreamClient {
  constructor(private config: CodexClientConfig) {}

  setReasoningEffort(_effort: string): void {}

  async stream(
    request: MessageRequest,
    callbacks: StreamCallbacks,
    signal?: AbortSignal,
  ): Promise<void> {
    const body = this.buildRequestBody(request)

    let lastError: Error | null = null
    for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
      try {
        const authHeaders = this.config.auth
          ? await this.config.auth.getHeaders()
          : {}

        const url = `${this.config.baseUrl.replace(/\/+$/, '')}/responses`
        const response = await fetch(url, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'User-Agent': CODEX_USER_AGENT,
            'Originator': CODEX_ORIGINATOR,
            'Accept': 'text/event-stream',
            'Connection': 'Keep-Alive',
            ...authHeaders,
          },
          body: JSON.stringify(body),
          signal,
        })

        if (!response.ok) {
          const errorBody = await response.text().catch(() => '')
          const status = response.status
          if (status >= 400 && status < 500 && status !== 429) {
            throw new Error(`Codex API error (${status}): ${errorBody}`)
          }
          lastError = new Error(`Codex API error (${status}): ${errorBody}`)
          if (attempt < MAX_RETRIES) {
            await delay(BASE_DELAY_MS * Math.pow(2, attempt - 1), signal)
            continue
          }
          throw lastError
        }

        await this.processSSEStream(response, callbacks, signal)
        return
      } catch (err) {
        if (signal?.aborted) throw err
        if (err instanceof Error && err.message.startsWith('Codex API error (4')) {
          throw err
        }
        lastError = err instanceof Error ? err : new Error(String(err))
        if (attempt < MAX_RETRIES) {
          await delay(BASE_DELAY_MS * Math.pow(2, attempt - 1), signal)
          continue
        }
      }
    }
    throw lastError ?? new Error('Codex request failed after retries')
  }

  private buildRequestBody(request: MessageRequest): Record<string, unknown> {
    const input: Record<string, unknown>[] = []

    // System message
    if (request.system) {
      const text = typeof request.system === 'string'
        ? request.system
        : request.system.map(b => b.text).join('\n')
      input.push({ role: 'developer', content: [{ type: 'input_text', text }] })
    }

    // Messages
    for (const msg of request.messages) {
      if (msg.role === 'user') {
        if (typeof msg.content === 'string') {
          input.push({ role: 'user', content: [{ type: 'input_text', text: msg.content }] })
        } else {
          const parts = msg.content.map(block => this.convertInputBlock(block))
          input.push({ role: 'user', content: parts })
        }
      } else if (msg.role === 'assistant') {
        if (typeof msg.content === 'string') {
          input.push({ role: 'assistant', content: [{ type: 'output_text', text: msg.content }] })
        } else {
          const parts = msg.content.map(block => this.convertAssistantBlock(block))
          input.push({ role: 'assistant', content: parts })
        }
      }
    }

    // Tools
    const tools = request.tools?.map(t => ({
      type: 'function',
      name: t.name,
      description: t.description,
      parameters: t.input_schema,
      strict: false,
    })) ?? []

    const body: Record<string, unknown> = {
      model: this.config.model,
      input,
      stream: true,
      max_output_tokens: request.max_tokens ?? this.config.maxTokens,
    }

    if (tools.length > 0) {
      body.tools = tools
    }

    if (request.temperature !== undefined) {
      body.temperature = request.temperature
    }

    return body
  }

  private convertInputBlock(block: ContentBlock): Record<string, unknown> {
    switch (block.type) {
      case 'text':
        return { type: 'input_text', text: block.text }
      case 'tool_result':
        return {
          type: 'function_call_output',
          call_id: block.tool_use_id,
          output: block.content,
        }
      default:
        return { type: 'input_text', text: JSON.stringify(block) }
    }
  }

  private convertAssistantBlock(block: ContentBlock): Record<string, unknown> {
    switch (block.type) {
      case 'text':
        return { type: 'output_text', text: block.text }
      case 'thinking':
        return { type: 'output_text', text: block.thinking }
      case 'tool_use':
        return {
          type: 'function_call',
          call_id: block.id,
          name: block.name,
          arguments: JSON.stringify(block.input),
        }
      default:
        return { type: 'output_text', text: JSON.stringify(block) }
    }
  }

  private async processSSEStream(
    response: Response,
    callbacks: StreamCallbacks,
    signal?: AbortSignal,
  ): Promise<void> {
    const reader = response.body?.getReader()
    if (!reader) throw new Error('No response body')

    const decoder = new TextDecoder()
    let buffer = ''
    let stopReason: string | null = null
    let usage: { input_tokens?: number; output_tokens?: number } | undefined

    // Track function calls by index
    const functionCalls = new Map<number, { id: string; name: string; arguments: string }>()

    try {
      while (true) {
        if (signal?.aborted) break
        const { done, value } = await reader.read()
        if (done) break

        buffer += decoder.decode(value, { stream: true })
        const lines = buffer.split('\n')
        buffer = lines.pop() ?? ''

        for (const line of lines) {
          const trimmed = line.trim()
          if (!trimmed.startsWith('data: ')) continue
          const data = trimmed.slice(6)
          if (data === '[DONE]') continue

          let parsed: Record<string, unknown>
          try {
            parsed = JSON.parse(data)
          } catch {
            continue
          }

          const type = parsed.type as string

          switch (type) {
            case 'response.output_text.delta': {
              const delta = parsed.delta as Record<string, unknown> | undefined
              const text = delta?.text as string | undefined
              if (text) callbacks.onTextDelta(text)
              break
            }

            case 'response.reasoning_text.delta': {
              const delta = parsed.delta as Record<string, unknown> | undefined
              const text = delta?.text as string | undefined
              if (text) callbacks.onThinkingDelta(text)
              break
            }

            case 'response.output_item.done': {
              const item = parsed.item as Record<string, unknown> | undefined
              if (item?.type === 'function_call') {
                const callId = (item.call_id as string) ?? `call_${functionCalls.size}`
                const name = item.name as string ?? ''
                const args = item.arguments as string ?? ''
                functionCalls.set(functionCalls.size, { id: callId, name, arguments: args })
                try {
                  const input = JSON.parse(args)
                  callbacks.onContentBlock({ type: 'tool_use', id: callId, name, input })
                } catch {}
              } else if (item?.type === 'message') {
                // Final message with usage
                const msgUsage = item.usage as Record<string, unknown> | undefined
                if (msgUsage) {
                  usage = {
                    input_tokens: msgUsage.input_tokens as number,
                    output_tokens: msgUsage.output_tokens as number,
                  }
                }
              }
              break
            }

            case 'response.completed': {
              const resp = parsed.response as Record<string, unknown> | undefined
              if (resp?.usage) {
                const u = resp.usage as Record<string, unknown>
                usage = {
                  input_tokens: u.input_tokens as number,
                  output_tokens: u.output_tokens as number,
                }
              }
              stopReason = 'stop'
              break
            }

            case 'response.failed': {
              const resp = parsed.response as Record<string, unknown> | undefined
              const error = resp?.error as Record<string, unknown> | undefined
              const msg = error?.message as string ?? 'Codex request failed'
              throw new Error(msg)
            }

            case 'error': {
              const msg = (parsed.message as string) ?? (parsed.error as string) ?? 'Unknown Codex error'
              throw new Error(`Codex stream error: ${msg}`)
            }
          }
        }
      }
    } finally {
      reader.releaseLock()
    }

    callbacks.onStopReason(stopReason ?? 'stop', {
      input_tokens: usage?.input_tokens ?? 0,
      output_tokens: usage?.output_tokens ?? 0,
      cache_creation_input_tokens: 0,
      cache_read_input_tokens: 0,
    })
  }
}

function delay(ms: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) return Promise.reject(new DOMException('Aborted', 'AbortError'))
  return new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, ms)
    signal?.addEventListener('abort', () => {
      clearTimeout(timer)
      reject(new DOMException('Aborted', 'AbortError'))
    }, { once: true })
  })
}
