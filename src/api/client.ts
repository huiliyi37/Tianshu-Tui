import type { MessageRequest, ContentBlock, Usage } from './types.js'
import type { StreamClient } from './stream-client.js'
import { SSEParser } from './sse.js'

class ApiError extends Error {
  constructor(
    message: string,
    public readonly status: number,
    public readonly retryAfterMs?: number,
  ) {
    super(message)
    this.name = 'ApiError'
  }
}

export interface ClientConfig {
  baseUrl: string
  apiKey: string
  model: string
  maxTokens: number
  thinking: 'enabled' | 'disabled'
  thinkingBudget?: number
  reasoningEffort?: string
  unsupported: string[]
  /** Whether the provider has a known bug where tool JSON appears in text content */
  hasToolJsonInContentBug: boolean
  /** Optional function to normalize usage fields from provider-specific format to standard Usage */
  mapUsage?: (raw: Record<string, unknown>) => Partial<Usage>
}

export interface StreamCallbacks {
  /** Streaming text delta for live display */
  onTextDelta: (text: string) => void
  /** Streaming thinking delta for live display */
  onThinkingDelta: (thinking: string) => void
  /** Complete content block (text, thinking, or tool_use with full input) */
  onContentBlock: (block: ContentBlock) => void
  /** Called when message_delta arrives with stop_reason + usage */
  onStopReason: (stopReason: string, usage: Partial<Usage>) => void
  onError: (error: Error) => void
}

interface ParsedSSEData {
  delta?: { type?: string; text?: string; thinking?: string; partial_json?: string }
  content_block?: { type: string; id?: string; name?: string }
  delta_stop_reason?: string
  usage?: Partial<Usage>
  error?: { type: string; message: string }
}

/** Internal state for buffering a streaming tool_use block */
interface ToolUseBuffer {
  id: string
  name: string
  partialJson: string
}

/** Attempt to recover a truncated JSON string from streaming input_json_delta */
function recoverTruncatedJSON(raw: string): Record<string, unknown> {
  let s = raw.trim()
  if (!s) return {}

  // Count unclosed structures
  let braceDepth = 0
  let bracketDepth = 0
  let inString = false
  let escaped = false
  for (const ch of s) {
    if (escaped) { escaped = false; continue }
    if (ch === '\\') { escaped = true; continue }
    if (ch === '"') { inString = !inString; continue }
    if (inString) continue
    if (ch === '{') braceDepth++
    if (ch === '}') braceDepth--
    if (ch === '[') bracketDepth++
    if (ch === ']') bracketDepth--
  }

  // Close unclosed string
  if (inString) s += '"'

  // Close unclosed structures
  s += ']'.repeat(bracketDepth)
  s += '}'.repeat(braceDepth)

  try {
    return JSON.parse(s) as Record<string, unknown>
  } catch {
    // Best-effort: extract key-value pairs via regex
    const recovered: Record<string, unknown> = {}
    const kvRe = /"([^"]+)"\s*:\s*("[^"]*"|\d+(?:\.\d+)?|true|false|null)/g
    let m: RegExpExecArray | null
    while ((m = kvRe.exec(raw)) !== null) {
      try { recovered[m[1]!] = JSON.parse(m[2]!) } catch { /* skip */ }
    }
    return recovered
  }
}

/** Schema gate: validate required fields are present in tool_use input */
export function validateRequiredFields(
  input: Record<string, unknown>,
  required: string[],
): string[] {
  if (required.length === 0) return []
  return required.filter(f => input[f] === undefined || input[f] === null)
}

/** DeepSeek V4 known bug: tool call JSON may appear in text content */
function extractToolJsonFromText(text: string): { name: string; input: Record<string, unknown> } | null {
  // Strategy 1: Try to find a JSON object with "name" and "input" keys via JSON.parse
  const jsonRe = /\{[\s\S]*?"name"[\s\S]*?"input"[\s\S]*?\}/g
  let match: RegExpExecArray | null
  while ((match = jsonRe.exec(text)) !== null) {
    try {
      const parsed = JSON.parse(match[0])
      if (parsed.name && typeof parsed.name === 'string' && parsed.input && typeof parsed.input === 'object') {
        return { name: parsed.name, input: parsed.input }
      }
    } catch { /* try next match */ }
  }

  // Strategy 2: Tight regex for common DeepSeek patterns
  // Match {"name": "tool_name", ... "input": {...}} with only whitespace/allowed keys between
  const strictRe = /\{\s*"name"\s*:\s*"(\w+)"\s*,\s*"input"\s*:\s*(\{[^{}]*(?:\{[^{}]*\}[^{}]*)*\})/
  const strictMatch = text.match(strictRe)
  if (strictMatch) {
    try {
      return { name: strictMatch[1]!, input: JSON.parse(strictMatch[2]!) as Record<string, unknown> }
    } catch { /* fall through */ }
  }

  return null
}

const MAX_RETRIES = 3
const BASE_DELAY_MS = 1000

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

async function withRetry<T>(
  fn: () => Promise<T>,
  signal?: AbortSignal,
): Promise<T> {
  let lastError: Error | null = null

  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    try {
      return await fn()
    } catch (err) {
      lastError = err as Error

      // Don't retry if aborted
      if (signal?.aborted) throw err

      // Don't retry on 4xx (except 429)
      const apiErr = lastError instanceof ApiError ? lastError : null
      const status = apiErr?.status ?? null
      if (status && status >= 400 && status < 500 && status !== 429) {
        throw err
      }

      if (attempt < MAX_RETRIES) {
        const delay = apiErr?.retryAfterMs ?? BASE_DELAY_MS * Math.pow(2, attempt - 1)
        await abortableDelay(delay, signal)
      }
    }
  }

  throw lastError
}

export class ApiClient implements StreamClient {
  constructor(private config: ClientConfig) {}

  private stripUnsupported(request: MessageRequest): MessageRequest {
    const req = { ...request }
    for (const field of this.config.unsupported) {
      delete (req as Record<string, unknown>)[field]
    }
    if (this.config.thinking === 'enabled') {
      ;(req as Record<string, unknown>)['thinking'] = { type: 'enabled', budget_tokens: this.config.thinkingBudget ?? 16000 }
      if (this.config.reasoningEffort) {
        ;(req as Record<string, unknown>)['reasoning_effort'] = this.config.reasoningEffort
      }
    }
    return req
  }

  async stream(
    request: MessageRequest,
    callbacks: StreamCallbacks,
    signal?: AbortSignal,
  ): Promise<void> {
    const toolSchemas = new Map<string, string[]>()
    if (request.tools) {
      for (const tool of request.tools) {
        toolSchemas.set(tool.name, tool.input_schema.required ?? [])
      }
    }

    const finalRequest = this.stripUnsupported({ ...request, stream: true })

    const response = await withRetry(
      () => fetch(`${this.config.baseUrl}/messages`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': this.config.apiKey,
          'anthropic-version': '2023-06-01',
        },
        body: JSON.stringify(finalRequest),
        signal,
      }).then(async (res) => {
        if (!res.ok) {
          const errorBody = await res.text().catch(() => '')
          let retryAfterMs: number | undefined
          if (res.status === 429) {
            const retryAfter = res.headers.get('retry-after')
            if (retryAfter) {
              const parsed = parseFloat(retryAfter)
              retryAfterMs = isNaN(parsed) ? undefined : parsed * 1000
            }
          }
          throw new ApiError(`API error ${res.status}: ${errorBody}`, res.status, retryAfterMs)
        }
        return res
      }),
      signal,
    )

    const reader = response.body?.getReader()
    if (!reader) throw new Error('Response body is not readable')

    const parser = new SSEParser()
    const decoder = new TextDecoder()
    let toolUseBuffer: ToolUseBuffer | null = null
    let textBlockOpen = false
    let thinkingBlockOpen = false
    let textContent = ''
    let thinkingContent = ''

    const flushTextBlock = () => {
      if (textBlockOpen && textContent) {
        callbacks.onContentBlock({ type: 'text', text: textContent })

        // DeepSeek V4 bug: tool JSON may appear in text content
        if (this.config.hasToolJsonInContentBug) {
          const extracted = extractToolJsonFromText(textContent)
          if (extracted) {
            callbacks.onContentBlock({
              type: 'tool_use',
              id: `fallback_${Date.now()}`,
              name: extracted.name,
              input: extracted.input,
            })
          }
        }

        textContent = ''
        textBlockOpen = false
      }
    }

    const flushThinkingBlock = () => {
      if (thinkingBlockOpen && thinkingContent) {
        callbacks.onContentBlock({ type: 'thinking', thinking: thinkingContent })
        thinkingContent = ''
        thinkingBlockOpen = false
      }
    }

    const abortHandler = () => { reader.cancel().catch(() => {}) }

    try {
      if (signal) {
        signal.addEventListener('abort', abortHandler, { once: true })
      }
      while (true) {
        if (signal?.aborted) break
        const { done, value } = await reader.read()
        if (done) break

        const chunk = decoder.decode(value, { stream: true })
        const events = parser.feed(chunk)

        for (const sse of events) {
          try {
            const data = JSON.parse(sse.data) as ParsedSSEData

            switch (sse.event) {
              case 'content_block_start': {
                const cb = data.content_block
                if (!cb) break

                // Flush previous block if switching type
                flushTextBlock()
                flushThinkingBlock()

                if (cb.type === 'text') {
                  textBlockOpen = true
                  textContent = ''
                } else if (cb.type === 'thinking') {
                  thinkingBlockOpen = true
                  thinkingContent = ''
                } else if (cb.type === 'tool_use' && cb.id && cb.name) {
                  toolUseBuffer = { id: cb.id, name: cb.name, partialJson: '' }
                }
                break
              }

              case 'content_block_delta': {
                const d = data.delta
                if (!d) break

                if (d.type === 'text_delta' && d.text) {
                  textContent += d.text
                  callbacks.onTextDelta(d.text)
                } else if (d.type === 'thinking_delta' && d.thinking) {
                  thinkingContent += d.thinking
                  callbacks.onThinkingDelta(d.thinking)
                } else if (d.type === 'input_json_delta' && d.partial_json !== undefined) {
                  if (toolUseBuffer) {
                    toolUseBuffer.partialJson += d.partial_json
                  }
                }
                break
              }

              case 'content_block_stop': {
                // Flush completed text/thinking blocks
                flushTextBlock()
                flushThinkingBlock()

                // Deliver completed tool_use block with parsed input
                if (toolUseBuffer) {
                  let input: Record<string, unknown> = {}
                  try {
                    input = JSON.parse(toolUseBuffer.partialJson) as Record<string, unknown>
                  } catch {
                    input = recoverTruncatedJSON(toolUseBuffer.partialJson)
                  }
                  // Schema gate: suppress tool_use with missing required fields
                  const requiredFields = toolSchemas.get(toolUseBuffer.name)
                  if (requiredFields && requiredFields.length > 0) {
                    const missing = validateRequiredFields(input, requiredFields)
                    if (missing.length > 0) {
                      callbacks.onContentBlock({
                        type: 'text',
                        text: `[schema-gate] Suppressed ${toolUseBuffer.name}: missing required (${missing.join(', ')}). Retry with complete parameters.`,
                      })
                      toolUseBuffer = null
                      break
                    }
                  }
                  callbacks.onContentBlock({
                    type: 'tool_use',
                    id: toolUseBuffer.id,
                    name: toolUseBuffer.name,
                    input,
                  })
                  toolUseBuffer = null
                }
                break
              }

              case 'message_delta': {
                const stopReason = data.delta_stop_reason ?? ''
                const rawUsage = data.usage ?? {}
                const usage = this.config.mapUsage ? this.config.mapUsage(rawUsage) : rawUsage
                callbacks.onStopReason(stopReason, usage)
                break
              }

              case 'error': {
                callbacks.onError(new Error(data.error?.message ?? 'Unknown API error'))
                // Terminate the stream on API error to prevent corrupted state
                reader.cancel().catch(() => {})
                break
              }
            }
          } catch {
            // skip non-JSON events
          }
        }
      }
    } finally {
      signal?.removeEventListener('abort', abortHandler)
      reader.releaseLock()
    }
  }
}
