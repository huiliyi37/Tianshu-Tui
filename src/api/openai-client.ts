import type { StreamClient } from './stream-client.js'
import type { MessageRequest, ToolDefinition } from './types.js'
import type { StreamCallbacks } from './client.js'
import { stableStringify } from './stable-json.js'
import { canonicalizeRequest } from './request-freezer.js'
import type { ProviderProfile } from './provider-profile.js'

export interface OpenAIClientConfig {
  baseUrl: string
  apiKey: string
  model: string
  maxTokens: number
  reasoningEffort?: string
  thinking?: 'enabled' | 'disabled'
  /** How to format thinking in the request body. 'openai' = use reasoning_effort only, others = use thinking block */
  thinkingFormat?: 'anthropic' | 'openai' | 'none'
  auth?: import('../auth/types.js').AuthProvider
  /** Stable session identifier for cache routing affinity */
  sessionId?: string
  /** Provider params to strip at all levels (preserves canonical prefix) */
  unsupported?: string[]
  /** Provider profile for cache strategy application */
  providerProfile?: ProviderProfile
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

const MAX_RETRIES = 3
const BASE_DELAY_MS = 1000
const READ_TIMEOUT_MS = 120_000

function toOpenAITool(tool: ToolDefinition): Record<string, unknown> {
  return {
    type: 'function',
    function: { name: tool.name, description: tool.description, parameters: tool.input_schema },
  }
}

function abortableDelay(ms: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) {
    return Promise.reject(new DOMException('Aborted', 'AbortError'))
  }
  return new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, ms)
    const onAbort = () => {
      clearTimeout(timer)
      reject(new DOMException('Aborted', 'AbortError'))
    }
    signal?.addEventListener('abort', onAbort, { once: true })
  })
}

export class OpenAIClient implements StreamClient {
  private toolCallBuffer = new Map<number, { id?: string; type?: string; function: { name?: string; arguments: string } }>()
  private pendingStopReason: string | null = null

  constructor(private config: OpenAIClientConfig) {}

  setReasoningEffort(effort: string): void {
    // OpenAI uses reasoning_effort in request body — store for next request
    this.config = { ...this.config, reasoningEffort: effort }
  }

  async stream(
    request: MessageRequest,
    callbacks: StreamCallbacks,
    signal?: AbortSignal,
  ): Promise<void> {
    // Canonicalize request for cache stability before building body
    const canonicalReq = (this.config.unsupported && this.config.providerProfile)
      ? canonicalizeRequest(request, this.config.providerProfile, this.config.unsupported)
      : request

    const body = this.buildRequestBody(canonicalReq)

    // Reset instance state to prevent stale data from previous calls/retries
    this.toolCallBuffer.clear()
    this.pendingStopReason = null

    let lastError: Error | null = null
    for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
      // Clear per-attempt state on retry
      this.toolCallBuffer.clear()
      this.pendingStopReason = null
      try {
        // Resolve auth headers: AuthProvider takes precedence over static apiKey
        const authHeaders = this.config.auth
          ? await this.config.auth.getHeaders()
          : { 'Authorization': `Bearer ${this.config.apiKey}` }

        const response = await fetch(`${this.config.baseUrl}/chat/completions`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Connection': 'keep-alive',
            ...authHeaders,
            ...(this.config.sessionId ? { 'X-Request-Session': this.config.sessionId } : {}),
          },
          body: stableStringify(body),
          signal,
        })

        if (!response.ok) {
          const errorBody = await response.text().catch(() => '')
          const status = response.status

          // Don't retry on 4xx (except 429)
          if (status >= 400 && status < 500 && status !== 429) {
            throw new Error(parseOpenAIError(status, errorBody))
          }

          lastError = new Error(parseOpenAIError(status, errorBody))

          if (attempt < MAX_RETRIES) {
            const retryAfter = response.headers.get('retry-after')
            const delay = retryAfter
              ? (parseFloat(retryAfter) || BASE_DELAY_MS) * 1000
              : BASE_DELAY_MS * Math.pow(2, attempt - 1)
            await abortableDelay(delay, signal)
            continue
          }
          throw lastError
        }

        const reader = response.body?.getReader()
        if (!reader) throw new Error('Response body is not readable')

        await this.parseStreamFromReader(reader, callbacks, signal)
        return // success — exit retry loop
      } catch (err) {
        if (signal?.aborted) throw err
        lastError = err as Error

        // Don't retry if it's an API error (already parsed above)
        if (lastError.message.startsWith('OpenAI API error')) throw lastError

        if (attempt < MAX_RETRIES) {
          await abortableDelay(BASE_DELAY_MS * Math.pow(2, attempt - 1), signal)
          continue
        }
        throw lastError
      }
    }
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
        const thinkingParts: string[] = []
        const toolCalls: OpenAIToolCall[] = []

        const blocks = typeof msg.content === 'string'
          ? [{ type: 'text' as const, text: msg.content }]
          : msg.content

        for (const block of blocks) {
          if (block.type === 'text') {
            textParts.push(block.text)
          } else if (block.type === 'thinking') {
            thinkingParts.push(block.thinking)
          } else if (block.type === 'tool_use') {
            toolCalls.push({
              id: block.id,
              type: 'function',
              function: {
                name: block.name,
                arguments: stableStringify(block.input),
              },
            })
          }
        }

        const assistant: Record<string, unknown> = { role: 'assistant' }
        if (textParts.length > 0) {
          assistant.content = textParts.join('')
        }
        // DeepSeek requires reasoning_content to be passed back in tool-call rounds
        if (thinkingParts.length > 0) {
          assistant.reasoning_content = thinkingParts.join('')
        }
        if (toolCalls.length > 0) {
          assistant.tool_calls = toolCalls
        }
        messages.push(assistant)
      }
    }

    const body: Record<string, unknown> = {
      model: this.config.model,
      messages,
      max_tokens: this.config.maxTokens,
      stream: true,
      stream_options: { include_usage: true },
    }

    if (request.tools && request.tools.length > 0) {
      body.tools = [...request.tools]
        .sort((a, b) => a.name.localeCompare(b.name))
        .map(toOpenAITool)
      body.tool_choice = 'auto'
    }

    // DeepSeek thinking mode: only send thinking body param for providers
    // that use DeepSeek-native format (anthropic thinkingFormat).
    // Providers with 'openai' thinkingFormat (GLM, MiniMax, Mimo) use
    // reasoning_effort only — sending {thinking: {type: 'enabled'}} causes
    // API errors or silent ingestion failures.
    if (this.config.thinking && this.config.thinkingFormat !== 'openai') {
      body.thinking = { type: this.config.thinking }
    }
    if (this.config.reasoningEffort) {
      body.reasoning_effort = this.config.reasoningEffort
    }

    return body
  }

  /** Parse SSE stream from a reader — exposed for testing */
  async parseStreamFromReader(
    reader: ReadableStreamDefaultReader<Uint8Array>,
    callbacks: Partial<Pick<StreamCallbacks, 'onTextDelta' | 'onContentBlock' | 'onStopReason'>>,
    signal?: AbortSignal,
  ): Promise<void> {
    const decoder = new TextDecoder()
    let buffer = ''
    let streamTimedOut = false
    let idleTimer: ReturnType<typeof setTimeout> | null = null

    const resetIdleTimer = () => {
      if (idleTimer) clearTimeout(idleTimer)
      idleTimer = setTimeout(() => {
        streamTimedOut = true
        reader.cancel().catch(() => {})
      }, READ_TIMEOUT_MS)
    }

    try {
      resetIdleTimer()
      let streamDone = false
      while (!streamDone) {
        if (signal?.aborted) throw new DOMException('Aborted', 'AbortError')
        if (streamTimedOut) throw new Error('OpenAI SSE stream idle timeout')

        const { done, value } = await reader.read()
        if (done) break

        resetIdleTimer()

        buffer += decoder.decode(value, { stream: true })
        const lines = buffer.split('\n')
        buffer = lines.pop() ?? ''

        for (const line of lines) {
          const trimmed = line.trim()
          if (!trimmed || !trimmed.startsWith('data: ')) continue

          const payload = trimmed.slice(6)
          if (payload === '[DONE]') { streamDone = true; break }

          try {
            const parsed = JSON.parse(payload)
            this.processDelta(parsed, callbacks)
          } catch {
            // Skip malformed SSE lines
          }
        }
      }

      // Process any residual data in the SSE buffer (final chunk without trailing newline)
      if (buffer.trim()) {
        const trimmed = buffer.trim()
        if (trimmed.startsWith('data: ')) {
          const payload = trimmed.slice(6)
          if (payload !== '[DONE]') {
            try {
              const parsed = JSON.parse(payload)
              this.processDelta(parsed, callbacks)
            } catch { /* skip malformed */ }
          }
        }
      }

      this.flushToolCalls(callbacks)

      // If no usage chunk arrived, emit stop reason now
      if (this.pendingStopReason) {
        callbacks.onStopReason?.(mapFinishReason(this.pendingStopReason), {})
        this.pendingStopReason = null
      }
    } finally {
      if (idleTimer) clearTimeout(idleTimer)
    }
  }

  /** Process a single SSE delta chunk — exposed for testing */
  processDelta(
    chunk: {
      choices?: Array<{
        delta: { content?: string | null; reasoning_content?: string | null; tool_calls?: Array<ToolCallChunk> }
        finish_reason?: string | null
      }>
      usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number; prompt_cache_hit_tokens?: number; prompt_cache_miss_tokens?: number; completion_tokens_details?: { reasoning_tokens?: number } }
    },
    callbacks: Partial<Pick<StreamCallbacks, 'onTextDelta' | 'onThinkingDelta' | 'onContentBlock' | 'onStopReason'>>,
  ): void {
    const choice = chunk.choices?.[0]

    // Usage-only chunk (final chunk with include_usage)
    if (chunk.usage && choice === undefined) {
      const usage = chunk.usage
      const stopReason = this.pendingStopReason ?? 'end_turn'
      this.pendingStopReason = null
      const cacheRead = usage.prompt_cache_hit_tokens ?? 0
      callbacks.onStopReason?.(mapFinishReason(stopReason), {
        input_tokens: usage.prompt_tokens ?? 0,
        output_tokens: usage.completion_tokens ?? 0,
        cache_read_input_tokens: cacheRead,
        cache_creation_input_tokens: usage.prompt_cache_miss_tokens ?? 0,
      })
      return
    }

    if (!choice) return

    const delta = choice.delta

    // DeepSeek reasoning_content → thinking delta
    if (delta.reasoning_content) {
      callbacks.onThinkingDelta?.(delta.reasoning_content)
    }

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
      // Buffer the stop reason — will be emitted when usage chunk arrives
      this.pendingStopReason = choice.finish_reason
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
    case 'insufficient_system_resource': return 'end_turn'  // DeepSeek-specific
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
