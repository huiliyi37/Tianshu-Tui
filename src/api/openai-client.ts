import type { StreamClient } from './stream-client.js'
import type { StreamCallbacks } from './stream-client.js'
import type { OaiChatRequest } from './oai-types.js'
import type { ProviderProfile } from './provider-profile.js'
import { shouldInjectPrefix, buildPrefixMessage } from './prefix-completion.js'
import { fetchWithTimeout } from './fetch-timeout.js'
import { withStructuredRetry } from './retry-engine.js'
import { parseRetryAfterMs } from './error-classifier.js'
import { sanitizeMessageContent } from '../utils/sanitize.js'
import { wireAbortToReaderCancel } from './abort-reader.js'

export interface OpenAIClientConfig {
  baseUrl: string
  apiKey: string
  model: string
  maxTokens: number
  reasoningEffort?: string
  thinking?: 'enabled' | 'disabled'
  /** How to format thinking in the request body. 'openai' = use reasoning_effort only, others = use thinking block */
  thinkingFormat?: 'anthropic' | 'openai' | 'none'
  /** How effort/thinking intensity is controlled. 'none' = provider doesn't support reasoning_effort */
  effortFormat?: 'reasoning_effort' | 'output_config' | 'none'
  auth?: import('../auth/types.js').AuthProvider
  /** Stable session identifier for cache routing affinity */
  sessionId?: string
  /** Provider params to strip at all levels (preserves canonical prefix) */
  unsupported?: string[]
  /** Provider profile for cache strategy application */
  providerProfile?: ProviderProfile
  /** Provider name for feature gating (e.g. 'glm' for web_search) */
  providerName?: string
  /** Enable DeepSeek Beta prefix completion (skip preamble) */
  prefixCompletion?: boolean
  /** Use max_completion_tokens instead of max_tokens (MiMo requires this per API docs) */
  useMaxCompletionTokens?: boolean
  /** Custom User-Agent header — required by providers that verify caller identity (e.g. Kimi) */
  userAgent?: string
  /** Provider-specific capability flags (网#1). */
  capabilities?: {
    /** DeepSeek sometimes emits tool JSON as plain text content. */
    hasToolJsonInContentBug?: boolean
  }
}

interface ToolCallChunk {
  index?: number
  id?: string
  type?: string
  function?: { name?: string; arguments?: string }
}

const FIRST_BYTE_TIMEOUT_MS = 45_000
const REASONING_FIRST_BYTE_TIMEOUT_MS = 90_000
const READ_TIMEOUT_MS = 120_000
const REASONING_READ_TIMEOUT_MS = 180_000
// GLM-5.1, Mimo, and DeepSeek (max reasoning) mandatory thinking can take 2-3
// minutes before first token. Use generous timeouts to avoid false-positive errors.
const SLOW_FIRST_BYTE_TIMEOUT_MS = 180_000
const SLOW_READ_TIMEOUT_MS = 300_000
/** Providers whose thinking mode can exceed 90s before first token. */
const SLOW_THINKING_PROVIDERS = new Set(['glm', 'mimo', 'deepseek', 'codex', 'minimax'])
/**
 * Thinking-stall timeout: once thinking tokens have been received, if no new
 * SSE chunk arrives within this window the stream is considered stuck.
 * This is shorter than SLOW_READ_TIMEOUT_MS (300s) because:
 *   - Pre-first-byte silence: model is generating, be patient (180s)
 *   - Mid-thinking stall after tokens arrived: model likely hung (90s)
 *   - Normal thinking bursts: tokens arrive every few seconds (no trigger)
 * 90s is generous enough for MiMo/GLM's legitimate pauses between reasoning
 * segments, but catches genuine hangs before the user waits 5 minutes.
 */
const THINKING_STALL_TIMEOUT_MS = 90_000

export class OpenAIClient implements StreamClient {
  private toolCallBuffer = new Map<number, { id?: string; type?: string; function: { name?: string; arguments: string } }>()
  private toolCallHintFired = new Set<number>()
  private pendingStopReason: string | null = null
  /** Accumulated text for DeepSeek tool-JSON-in-content fallback (网#1). */
  private _textAccum = ''
  /** Stable suffix appended to system message for Chinese thinking (computed once, cache-safe). */
  private readonly systemSuffix: string

  constructor(private config: OpenAIClientConfig) {
    this.systemSuffix = (config.providerName === 'mimo' || config.providerName === 'deepseek') && config.thinking === 'enabled'
      ? '\n\n请在内部思考链中使用中文进行推理。不要在回复中输出你的推理过程，只输出最终答案或工具调用。'
      : ''
    this._sanitizedCount = 0
  }

  // ── Incremental sanitize ─────────────────────────────────────
  // Historical messages are already sanitized at entry points
  // (addUserMessage/addAssistantBlocks/addToolResults). Re-sanitizing
  // the full message array every turn is O(history) overhead that grows
  // linearly with conversation length — particularly wasteful at 1M
  // context windows. We track the sanitized count and only apply the
  // safety-net sanitize to newly appended messages.
  private _sanitizedCount: number

  setReasoningEffort(effort: string): void {
    // OpenAI uses reasoning_effort in request body — store for next request
    this.config = { ...this.config, reasoningEffort: effort }
  }

  setThinking(mode: 'enabled' | 'disabled'): void {
    this.config = { ...this.config, thinking: mode }
  }

  async stream(
    request: OaiChatRequest,
    callbacks: StreamCallbacks,
    signal?: AbortSignal,
  ): Promise<void> {
    // DeepSeek thinking mode reasoning_content rules (official docs):
    // - Tool-call turns: reasoning_content MUST be echoed in all subsequent requests.
    // - Pure text turns (no tool_calls): reasoning_content is ignored by the API;
    //   strip it to avoid bloating context and potentially triggering repetition.
    // - Thinking disabled: strip all reasoning_content.
    const messages = request.messages.map(m => {
      if (m.role !== 'assistant' || !('reasoning_content' in m)) return m
      const hasToolCalls = Array.isArray((m as any).tool_calls) && (m as any).tool_calls.length > 0
      if (this.config.thinking === 'enabled' && hasToolCalls) return m
      const { reasoning_content: _, ...rest } = m
      // DeepSeek requires assistant messages to have `content` or `tool_calls`.
      // After stripping reasoning_content, ensure `content` exists.
      if (!('content' in rest) && !hasToolCalls) {
        (rest as Record<string, unknown>).content = ''
      }
      return rest
    })

    const body: Record<string, unknown> = {
      model: request.model,
      messages,
      stream: true,
    }

    // MiMo API uses max_completion_tokens, standard OpenAI uses max_tokens
    if (this.config.useMaxCompletionTokens) {
      body.max_completion_tokens = request.max_tokens ?? this.config.maxTokens
    } else {
      body.max_tokens = request.max_tokens ?? this.config.maxTokens
    }

    // stream_options: { include_usage: true } is an OpenAI extension.
    // Some providers return 400 if unsupported.
    if (!this.config.unsupported?.includes('stream_options')) {
      body.stream_options = { include_usage: true }
    }

    if (request.tools && request.tools.length > 0) {
      body.tools = request.tools
      if (request.tool_choice) body.tool_choice = request.tool_choice
    }

    if (request.temperature !== undefined) body.temperature = request.temperature

    // MiniMax: reasoning_split separates thinking into reasoning_content field
    // (DeepSeek-compatible), otherwise thinking is embedded in <think> tags inside content
    if (this.config.providerName === 'minimax') {
      body.reasoning_split = true
    }

    // Thinking / reasoning dispatch.
    // Providers that accept {thinking: {type: 'enabled'}} (DeepSeek, GLM, etc.):
    // send the thinking block. Pure OpenAI providers use reasoning_effort.
    const usesThinkingBlock = this.config.thinkingFormat === 'anthropic'
      || this.config.providerName === 'glm'
      || this.config.providerName === 'claude'
      || this.config.providerName === 'mimo'
      || this.config.providerName === 'minimax'

    if (this.config.thinking === 'enabled') {
      if (usesThinkingBlock) {
        body.thinking = { type: this.config.thinking }
        if (this.config.providerName === 'minimax') {
          body.thinking = { type: 'adaptive' }
        }
        // GLM Preserved Thinking: retain previous reasoning across turns.
        // Reduces thinking time (incremental vs. full re-reasoning), improves
        // cache hit rate, and is officially recommended for Coding/Agent use.
        // Requires echoing reasoning_content back in subsequent requests
        // (already handled by echoReasoning logic above).
        if (this.config.providerName === 'glm') {
          (body.thinking as Record<string, unknown>)['clear_thinking'] = false
        }
        if (this.config.providerName === 'claude' && this.config.reasoningEffort) {
          const budgetMap: Record<string, number> = {
            max: this.config.maxTokens,
            high: Math.floor(this.config.maxTokens * 0.6),
            medium: Math.floor(this.config.maxTokens * 0.3),
            low: 8192,
            off: 0,
          }
          const budget = budgetMap[this.config.reasoningEffort ?? 'high'] ?? Math.floor(this.config.maxTokens * 0.6)
          ;(body.thinking as Record<string, unknown>)['budget_tokens'] = budget
        }
      } else if (this.config.effortFormat !== 'none') {
        body.reasoning_effort = this.config.reasoningEffort ?? 'medium'
      }
    }
    if (request.reasoning_effort && this.config.effortFormat !== 'none') {
      body.reasoning_effort = request.reasoning_effort
    }
    // Codex (served via cliproxy) tops out at 'xhigh', not Rivet's canonical
    // 'max'. Map at the wire so the global ReasoningEffort enum stays unchanged
    // and other providers keep receiving 'max'.
    if (this.config.providerName === 'codex' && body.reasoning_effort === 'max') {
      body.reasoning_effort = 'xhigh'
    }

    // Apply stable system suffix (Chinese thinking instruction) — computed once at construction.
    if (this.systemSuffix) {
      const sysMsg = (body.messages as Record<string, unknown>[]).find(m => m.role === 'system')
      if (sysMsg && typeof sysMsg.content === 'string') {
        sysMsg.content += this.systemSuffix
      }
    }

    // Incremental sanitize: only re-sanitize messages appended since last
    // request. Historical messages were already sanitized at entry points
    // (addUserMessage/addAssistantBlocks/addToolResults). This avoids O(n)
    // overhead that grows linearly with conversation length.
    const msgArray = body.messages as Array<Record<string, unknown>>
    if (msgArray.length <= this._sanitizedCount) {
      // Compaction or message replacement: reset and full sanitize
      this._sanitizedCount = 0
    }
    const newMessages = msgArray.slice(this._sanitizedCount)
    if (newMessages.length > 0) {
      const sanitizedNew = sanitizeMessageContent(newMessages)
      for (let i = 0; i < sanitizedNew.length; i++) {
        msgArray[this._sanitizedCount + i] = sanitizedNew[i]!
      }
      this._sanitizedCount = msgArray.length
    }

    await this.sendStream(body, callbacks, signal)
  }

  /** Shared inner retry+fetch+SSE loop used by both stream and streamOai. */
  private async sendStream(
    body: Record<string, unknown>,
    callbacks: StreamCallbacks,
    signal?: AbortSignal,
  ): Promise<void> {
    // reasoningRef survives retry attempts within this sendStream call.
    // When a mid-stream failure occurs (e.g. idle timeout, connection reset),
    // the accumulated reasoning_content is saved here and echoed back to the
    // model on the next retry so it doesn't have to redo all the thinking.
    const reasoningRef = { content: '' }
    const isThinking = this.config.thinking === 'enabled'

    await withStructuredRetry(async () => {
      // Reset instance state for each attempt
      this.toolCallBuffer.clear()
      this.toolCallHintFired.clear()
      this.pendingStopReason = null
      this._textAccum = ''

      // Inject previous reasoning into messages on retry so the model can
      // resume from where it left off instead of restarting from scratch.
      // DeepSeek requires assistant messages to have `content` or `tool_calls`.
      let effectiveBody = body
      if (isThinking && reasoningRef.content) {
        const msgs = [...(body.messages as unknown[]), {
          role: 'assistant',
          content: '',
          reasoning_content: reasoningRef.content,
        }]
        effectiveBody = { ...body, messages: msgs }
      }

      // Resolve auth headers: AuthProvider takes precedence over static apiKey
      const authHeaders = this.config.auth
        ? await this.config.auth.getHeaders()
        : { 'Authorization': `Bearer ${this.config.apiKey}` }

      // Pre-first-byte timeout prevents fetch from hanging forever
      // when server accepts connection but never sends response headers.
      const fetchTimeout = this.config.thinking === 'enabled'
        ? (SLOW_THINKING_PROVIDERS.has(this.config.providerName ?? '') ? SLOW_FIRST_BYTE_TIMEOUT_MS : REASONING_FIRST_BYTE_TIMEOUT_MS)
        : FIRST_BYTE_TIMEOUT_MS
      const response = await fetchWithTimeout(`${this.config.baseUrl}/chat/completions`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Connection': 'keep-alive',
          ...(this.config.userAgent ? { 'User-Agent': this.config.userAgent } : {}),
          ...authHeaders,
          ...(this.config.sessionId ? { 'X-Request-Session': this.config.sessionId } : {}),
        },
        body: JSON.stringify(effectiveBody),
        signal,
      }, fetchTimeout)

      if (!response.ok) {
        const errorBody = await response.text().catch(() => '')
        const err = Object.assign(
          new Error(parseOpenAIError(response.status, errorBody)),
          { status: response.status },
        )
        // Attach parsed retry-after for the error classifier to use
        const retryAfter = response.headers.get('retry-after')
        if (retryAfter) {
          const retryAfterMs = parseRetryAfterMs(retryAfter)
          if (retryAfterMs !== undefined) {
            ;(err as Error & { retryAfterMs?: number }).retryAfterMs = retryAfterMs
          }
        }
        throw err
      }

      const reader = response.body?.getReader()
      if (!reader) throw new Error('Response body is not readable')

      await this.parseStreamFromReader(reader, callbacks, signal, reasoningRef)
    }, signal, {
      maxTotalDurationMs: 10 * 60_000,
      maxTotalRetries: isThinking ? 1 : undefined,
      onRetry: (info) => {
        if (info.classified.category === 'rate_limit') {
          callbacks.onRateLimit?.(info.classified.retryDelayMs)
        }
      },
    })
  }

  /** Parse SSE stream from a reader — exposed for testing */

  /** Parse SSE stream from a reader — exposed for testing */
  async parseStreamFromReader(
    reader: ReadableStreamDefaultReader<Uint8Array>,
    callbacks: Partial<Pick<StreamCallbacks, 'onTextDelta' | 'onContentBlock' | 'onStopReason'>>,
    signal?: AbortSignal,
    reasoningRef?: { content: string },
  ): Promise<void> {
    const decoder = new TextDecoder()
    let buffer = ''
    let streamTimedOut = false
    let idleTimer: ReturnType<typeof setTimeout> | null = null
    let receivedFirstChunk = false
    /** Whether any reasoning_content has been received — used to detect thinking stalls. */
    let receivedThinking = false
    // GLM-5.1 mandatory thinking mode outputs everything as reasoning_content
    // with no content field. Accumulate reasoning to promote if no content arrives.
    let reasoningAccum = ''
    let textReceived = false
    let promotionFired = false

    // Create an internal timeout AbortSignal for hard timeout guarantee.
    // This ensures reader.read() is unblocked even if reader.cancel() alone
    // cannot break the TCP connection (e.g. GLM server keeps connection alive).
    // Max stream duration = 10 minutes (aligned with withStructuredRetry budget).
    const timeoutController = new AbortController()
    const maxStreamMs = 10 * 60_000
    const maxStreamTimer = setTimeout(() => timeoutController.abort(), maxStreamMs)

    // Wire both external and timeout signals to reader.cancel() so that
    // either agent.abort() OR the hard timeout can interrupt blocking read().
    const signalCleanup = signal
      ? wireAbortToReaderCancel(AbortSignal.any([signal, timeoutController.signal]), reader)
      : wireAbortToReaderCancel(timeoutController.signal, reader)

    const resetIdleTimer = () => {
      if (idleTimer) clearTimeout(idleTimer)
      const isReasoning = this.config.thinking === 'enabled'
      const isSlowProvider = SLOW_THINKING_PROVIDERS.has(this.config.providerName ?? '')
      const firstByteMs = isSlowProvider ? SLOW_FIRST_BYTE_TIMEOUT_MS
        : isReasoning ? REASONING_FIRST_BYTE_TIMEOUT_MS : FIRST_BYTE_TIMEOUT_MS
      const readMs = isSlowProvider ? SLOW_READ_TIMEOUT_MS
        : isReasoning ? REASONING_READ_TIMEOUT_MS : READ_TIMEOUT_MS
      // Thinking-stall detection: once thinking tokens have arrived but no text
      // content yet, use a shorter timeout to catch stalled thinking streams.
      // Without this, a mimo/glm model that sends one thinking chunk then hangs
      // would silently block for 300s (SLOW_READ_TIMEOUT_MS) before timeout.
      const thinkingStallMs = (receivedThinking && !textReceived)
        ? THINKING_STALL_TIMEOUT_MS
        : null
      const timeout = receivedFirstChunk
        ? (thinkingStallMs ?? readMs)
        : firstByteMs
      idleTimer = setTimeout(() => {
        streamTimedOut = true
        reader.cancel().catch(() => {})
      }, timeout)
    }

    try {
      resetIdleTimer()
      let streamDone = false
      while (!streamDone) {
        // Check both external signal and internal timeout signal.
        // External signal: agent.abort() / worker budget / Ctrl+C
        // Timeout signal: hard 10min ceiling on stream duration
        if (signal?.aborted) throw new DOMException('Aborted', 'AbortError')
        if (timeoutController.signal.aborted) {
          throw new Error('OpenAI SSE stream hard timeout (10min) — stream exceeded maximum duration')
        }

        const { done, value } = await reader.read()
        // Check timeout AFTER read — reader.cancel() from idle timer causes
        // read() to return done=true, but we must throw, not silently break.
        if (streamTimedOut) {
          const msg = (receivedThinking && !textReceived)
            ? 'OpenAI SSE stream thinking stall timeout (90s) — model stopped producing thinking tokens'
            : 'OpenAI SSE stream idle timeout'
          throw new Error(msg)
        }
        if (done) break

        receivedFirstChunk = true
        resetIdleTimer()

        buffer += decoder.decode(value, { stream: true })
        const lines = buffer.split('\n')
        buffer = lines.pop() ?? ''

        for (const line of lines) {
          const trimmed = line.trim()
          if (!trimmed || !trimmed.startsWith('data:')) continue

          const payload = trimmed.slice(5).trimStart()
          if (payload === '[DONE]') { streamDone = true; break }

          try {
            const parsed = JSON.parse(payload)
            this.processDelta(parsed, callbacks)
            // Track whether text/content was received (for reasoning promotion fallback)
            if (parsed.choices?.[0]?.delta?.content) textReceived = true
            if (parsed.choices?.[0]?.delta?.reasoning_content) {
              reasoningAccum += parsed.choices[0].delta.reasoning_content
              receivedThinking = true
              if (reasoningRef) reasoningRef.content = reasoningAccum
            }
          } catch {
            // Skip malformed SSE lines
          }
        }
      }

      // Process any residual data in the SSE buffer (final chunk without trailing newline)
      if (buffer.trim()) {
        const trimmed = buffer.trim()
        if (trimmed.startsWith('data:')) {
          const payload = trimmed.slice(5).trimStart()
          if (payload !== '[DONE]') {
            try {
              const parsed = JSON.parse(payload)
              this.processDelta(parsed, callbacks)
              if (parsed.choices?.[0]?.delta?.content) textReceived = true
              if (parsed.choices?.[0]?.delta?.reasoning_content) {
                reasoningAccum += parsed.choices[0].delta.reasoning_content
                receivedThinking = true
                if (reasoningRef) reasoningRef.content = reasoningAccum
              }
            } catch { /* skip malformed */ }
          }
        }
      }

      this.flushToolCalls(callbacks)
      // 网#1: DeepSeek tool-JSON-in-content fallback
      if (this.toolCallBuffer.size === 0 && this._textAccum && this.config.capabilities?.hasToolJsonInContentBug) {
        this.tryParseToolJsonFromContent(this._textAccum, callbacks)
      }
      this._textAccum = ''

      // Emit thinking content block so reasoning_content can be passed back
      // in subsequent requests. Mimo, MiniMax, and other OpenAI-compatible
      // providers that return reasoning_content require it to be echoed.
      if (reasoningAccum) {
        callbacks.onContentBlock?.({ type: 'thinking', thinking: reasoningAccum })
      }

      // GLM-5.1 mandatory thinking: if only reasoning_content arrived (no content),
      // promote reasoning to visible text so the TUI shows a reply.
      // ONLY promote for GLM — MiMo/DeepSeek properly separate reasoning from
      // content. When MiMo sends a tool-call turn (reasoning_content + tool_calls
      // but no content), promoting would leak thinking into visible text.
      if (!textReceived && reasoningAccum && this.config.providerName === 'glm') {
        callbacks.onTextDelta?.(reasoningAccum)
        promotionFired = true
      }

      // If no usage chunk arrived, emit stop reason now
      if (this.pendingStopReason) {
        callbacks.onStopReason?.(mapFinishReason(this.pendingStopReason), {})
        this.pendingStopReason = null
      }
    } finally {
      if (idleTimer) clearTimeout(idleTimer)
      if (maxStreamTimer) clearTimeout(maxStreamTimer)
      if (signalCleanup) signalCleanup()

      // Promote reasoning to text even on stream error — prevents GLM "stuck" when
      // stream breaks after receiving reasoning_content but before normal completion.
      // Only for GLM — see main promotion block above for rationale.
      if (!textReceived && reasoningAccum && !promotionFired && this.config.providerName === 'glm') {
        callbacks.onTextDelta?.(reasoningAccum)
      }
    }
  }

  /** Process a single SSE delta chunk — exposed for testing */
  processDelta(
    chunk: {
      choices?: Array<{
        delta: { content?: string | null; reasoning_content?: string | null; tool_calls?: Array<ToolCallChunk> }
        finish_reason?: string | null
      }>
      usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number; prompt_cache_hit_tokens?: number; prompt_cache_miss_tokens?: number; prompt_tokens_details?: { cached_tokens?: number }; completion_tokens_details?: { reasoning_tokens?: number } }
    },
    callbacks: Partial<Pick<StreamCallbacks, 'onTextDelta' | 'onThinkingDelta' | 'onContentBlock' | 'onStopReason' | 'onToolCallHint'>>,
  ): void {
    const choice = chunk.choices?.[0]

    // Usage-only chunk (final chunk with include_usage)
    if (chunk.usage && choice === undefined) {
      const usage = chunk.usage
      const stopReason = this.pendingStopReason ?? 'end_turn'
      this.pendingStopReason = null
      const cacheRead = usage.prompt_cache_hit_tokens ?? usage.prompt_tokens_details?.cached_tokens ?? 0
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
      if (this.config.capabilities?.hasToolJsonInContentBug) {
        this._textAccum += delta.content
      }
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

        // Speculative prewarm: emit hint once when tool name + args are parseable
        if (callbacks.onToolCallHint && buf.function.name && !this.toolCallHintFired.has(idx)) {
          try {
            const partial = JSON.parse(buf.function.arguments)
            this.toolCallHintFired.add(idx)
            callbacks.onToolCallHint(buf.function.name, partial)
          } catch { /* args not yet complete JSON — wait for more chunks */ }
        }
      }
    }

    if (choice.finish_reason) {
      this.flushToolCalls(callbacks)
      // Buffer the stop reason — will be emitted when usage chunk arrives
      this.pendingStopReason = choice.finish_reason
    }

    // If usage arrived together with finish_reason in the same SSE chunk,
    // emit onStopReason immediately with usage data. This handles providers
    // (DeepSeek) that combine finish_reason + usage into one chunk, unlike
    // OpenAI which sends usage as a separate trailing chunk.
    // Must run AFTER flushToolCalls (tool_use content blocks emitted first)
    // and AFTER pendingStopReason is set (so we can read it here).
    if (chunk.usage && this.pendingStopReason !== null) {
      const usage = chunk.usage
      const stopReason = this.pendingStopReason
      this.pendingStopReason = null
      const cacheRead = usage.prompt_cache_hit_tokens ?? usage.prompt_tokens_details?.cached_tokens ?? 0
      callbacks.onStopReason?.(mapFinishReason(stopReason), {
        input_tokens: usage.prompt_tokens ?? 0,
        output_tokens: usage.completion_tokens ?? 0,
        cache_read_input_tokens: cacheRead,
        cache_creation_input_tokens: usage.prompt_cache_miss_tokens ?? 0,
      })
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

  /** 网#1: Parse tool JSON from accumulated text content (DeepSeek bug workaround). */
  private tryParseToolJsonFromContent(
    text: string,
    callbacks: Partial<Pick<StreamCallbacks, 'onContentBlock'>>,
  ): void {
    const trimmed = text.trim()
    if (!trimmed.startsWith('{') && !trimmed.startsWith('[')) return
    try {
      const parsed: unknown = JSON.parse(trimmed)
      const toolCalls = Array.isArray(parsed) ? parsed : [parsed]
      let emitted = 0
      for (const tc of toolCalls) {
        if (typeof tc !== 'object' || tc === null) continue
        const obj = tc as Record<string, unknown>
        if (typeof obj.name !== 'string') continue
        const input = typeof obj.arguments === 'object' && obj.arguments !== null
          ? obj.arguments as Record<string, unknown>
          : typeof obj.arguments === 'string'
            ? (() => { try { return JSON.parse(obj.arguments as string) as Record<string, unknown> } catch { return {} } })()
            : {}
        callbacks.onContentBlock?.({ type: 'tool_use', id: `fallback_${obj.name}_${emitted}`, name: obj.name, input })
        emitted++
      }
    } catch { /* Not valid JSON */ }
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
