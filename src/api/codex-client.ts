import type { StreamClient } from './stream-client.js'
import type { MessageRequest, ContentBlock } from './types.js'
import type { StreamCallbacks } from './client.js'
import { withStructuredRetry } from './retry-engine.js'

export interface CodexClientConfig {
  baseUrl: string
  model: string
  maxTokens: number
  auth?: import('../auth/types.js').AuthProvider
}

const CODEX_USER_AGENT = 'codex_cli_rs/0.118.0 (Mac OS 26.3.1; arm64) iTerm.app/3.6.9'
const CODEX_ORIGINATOR = 'codex_cli_rs'

export class CodexClient implements StreamClient {
  constructor(private config: CodexClientConfig) {}

  setReasoningEffort(_effort: string): void {}

  async stream(
    request: MessageRequest,
    callbacks: StreamCallbacks,
    signal?: AbortSignal,
  ): Promise<void> {
    const body = this.buildRequestBody(request)

    await withStructuredRetry(async () => {
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
        throw Object.assign(
          new Error(`Codex API error (${response.status}): ${errorBody}`),
          { status: response.status },
        )
      }

      await this.processSSEStream(response, callbacks, signal)
    }, signal)
  }

  private buildRequestBody(request: MessageRequest): Record<string, unknown> {
    const input: Record<string, unknown>[] = []

    // System message → top-level `instructions` (Codex Responses API requirement)
    let instructions: string | undefined
    if (request.system) {
      instructions = typeof request.system === 'string'
        ? request.system
        : request.system.map(b => b.text).join('\n')
    }

    // Messages — function_call and function_call_output are top-level input items
    for (const msg of request.messages) {
      if (msg.role === 'user') {
        if (typeof msg.content === 'string') {
          input.push({ type: 'message', role: 'user', content: [{ type: 'input_text', text: msg.content }] })
        } else {
          // Separate tool results from text content
          const textParts: Record<string, unknown>[] = []
          for (const block of msg.content) {
            if (block.type === 'tool_result') {
              // Top-level function_call_output
              input.push({
                type: 'function_call_output',
                call_id: block.tool_use_id,
                output: block.content,
              })
            } else {
              textParts.push(this.convertInputBlock(block))
            }
          }
          if (textParts.length > 0) {
            input.push({ type: 'message', role: 'user', content: textParts })
          }
        }
      } else if (msg.role === 'assistant') {
        if (typeof msg.content === 'string') {
          input.push({ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: msg.content }] })
        } else {
          // Separate tool calls from text content
          const textParts: Record<string, unknown>[] = []
          for (const block of msg.content) {
            if (block.type === 'tool_use') {
              // Top-level function_call
              input.push({
                type: 'function_call',
                call_id: block.id,
                name: block.name,
                arguments: JSON.stringify(block.input),
              })
            } else {
              const converted = this.convertAssistantBlock(block)
              if (converted) textParts.push(converted)
            }
          }
          if (textParts.length > 0) {
            input.push({ type: 'message', role: 'assistant', content: textParts })
          }
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
      store: false,
      parallel_tool_calls: true,
      include: ['reasoning.encrypted_content'],
      reasoning: { effort: 'high' },
    }

    if (instructions) {
      body.instructions = instructions
    }

    if (tools.length > 0) {
      body.tools = tools
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
        return null as unknown as Record<string, unknown>
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

    // Reasoning-before-text ordering buffer.
    // DeepSeek Codex API may emit output_item.done (message) before
    // output_item.done (reasoning). Without buffering, the TUI shows
    // text first, then reasoning "flashes" in after — breaking the
    // expected thinking→answer order. We buffer the message item
    // until either a reasoning item arrives or the stream ends.
    let pendingMessageItem: {
      texts: string[]
      blocks: ContentBlock[]
      msgUsage?: Record<string, unknown>
    } | null = null
    let seenReasoningItem = false
    let seenTextDelta = false

    const flushPendingMessage = () => {
      if (!pendingMessageItem) return
      if (!seenTextDelta) {
        for (const t of pendingMessageItem.texts) {
          callbacks.onTextDelta(t)
        }
      }
      for (const b of pendingMessageItem.blocks) {
        callbacks.onContentBlock(b)
      }
      if (pendingMessageItem.msgUsage) {
        usage = {
          input_tokens: pendingMessageItem.msgUsage.input_tokens as number,
          output_tokens: pendingMessageItem.msgUsage.output_tokens as number,
        }
      }
      pendingMessageItem = null
    }

    // SSE idle timeout — same pattern as ApiClient and OpenAIClient
    const READ_TIMEOUT_MS = 180_000
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
      while (true) {
        if (signal?.aborted) break
        if (streamTimedOut) throw new Error('Codex SSE stream idle timeout (180s)')

        const { done, value } = await reader.read()
        if (done) break
        resetIdleTimer()

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
              seenTextDelta = true
              // delta is a plain string, not { text: "..." }
              const text = typeof parsed.delta === 'string'
                ? parsed.delta
                : (parsed.delta as Record<string, unknown>)?.text as string | undefined
              if (text) callbacks.onTextDelta(text)
              break
            }

            case 'response.reasoning_text.delta':
            case 'response.reasoning_summary_text.delta': {
              seenReasoningItem = true
              const text = typeof parsed.delta === 'string'
                ? parsed.delta
                : (parsed.delta as Record<string, unknown>)?.text as string | undefined
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
              } else if (item?.type === 'reasoning') {
                // Reasoning item — emit BEFORE text so TUI captures thinking first.
                // The summary array contains sanitized reasoning content.
                seenReasoningItem = true
                const summary = item.summary as Array<Record<string, unknown>> | undefined
                if (summary) {
                  for (const s of summary) {
                    if (typeof s.text === 'string') {
                      callbacks.onThinkingDelta(s.text)
                    }
                  }
                }
                // Flush any buffered message that arrived before reasoning
                flushPendingMessage()
              } else if (item?.type === 'message') {
                // Text message — buffer if reasoning hasn't arrived yet,
                // otherwise emit immediately.
                const content = item.content as Array<Record<string, unknown>> | undefined
                const msgUsage = item.usage as Record<string, unknown> | undefined

                if (!seenReasoningItem) {
                  // Buffer: reasoning hasn't arrived, hold this message
                  const texts: string[] = []
                  const blocks: ContentBlock[] = []
                  if (content) {
                    for (const part of content) {
                      if (part.type === 'output_text' && typeof part.text === 'string') {
                        texts.push(part.text)
                        blocks.push({ type: 'text', text: part.text })
                      }
                    }
                  }
                  pendingMessageItem = { texts, blocks, msgUsage }
                } else {
                  // Emit immediately: reasoning already seen
                  if (content) {
                    for (const part of content) {
                      if (part.type === 'output_text' && typeof part.text === 'string') {
                        if (!seenTextDelta) callbacks.onTextDelta(part.text)
                        callbacks.onContentBlock({ type: 'text', text: part.text })
                      }
                    }
                  }
                  if (msgUsage) {
                    usage = {
                      input_tokens: msgUsage.input_tokens as number,
                      output_tokens: msgUsage.output_tokens as number,
                    }
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
      if (idleTimer) clearTimeout(idleTimer)
      reader.releaseLock()
    }

    // Flush any buffered message that arrived before reasoning (e.g. no-reasoning responses)
    flushPendingMessage()

    callbacks.onStopReason(stopReason ?? 'stop', {
      input_tokens: usage?.input_tokens ?? 0,
      output_tokens: usage?.output_tokens ?? 0,
      cache_creation_input_tokens: 0,
      cache_read_input_tokens: 0,
    })
  }
}
