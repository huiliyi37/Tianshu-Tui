/**
 * DeepSeek Responses API StreamClient — Chat Completions 双栈的 Responses 侧。
 *
 * 仅 deepseek-v4-flash（官方限制）。把 OaiChatRequest 改写为 /responses body，
 * SSE 事件映射到既有 StreamCallbacks。effort 走 reasoning.effort。
 */

import type { StreamClient } from './stream-client.js'
import type { StreamCallbacks } from './stream-client.js'
import type { OaiChatRequest } from './oai-types.js'
import type { ContentBlock } from './types.js'
import { withStructuredRetry } from './retry-engine.js'
import { parseRetryAfterMs } from './error-classifier.js'
import { fetchWithTimeout } from './fetch-timeout.js'
import { wireAbortToReaderCancel, wrapBodyTimeoutError } from './abort-reader.js'
import {
  buildDeepSeekResponsesBody,
  supportsDeepSeekResponses,
} from './deepseek-responses.js'

export interface DeepSeekResponsesClientConfig {
  baseUrl: string
  apiKey: string
  model: string
  maxTokens: number
  reasoningEffort?: string
  thinking?: 'enabled' | 'disabled'
  sessionId?: string
}

function extractReasoningTokens(usage: Record<string, unknown>): number | undefined {
  const details = usage.output_tokens_details as Record<string, unknown> | undefined
  const reasoning = details?.reasoning_tokens
  return typeof reasoning === 'number' ? reasoning : undefined
}

export class DeepSeekResponsesClient implements StreamClient {
  private reasoningEffort: string | undefined
  private thinking: 'enabled' | 'disabled'

  constructor(private config: DeepSeekResponsesClientConfig) {
    this.reasoningEffort = config.reasoningEffort
    this.thinking = config.thinking ?? 'enabled'
    if (!supportsDeepSeekResponses(config.model)) {
      throw new Error(
        `DeepSeek Responses API only supports deepseek-v4-flash (got ${config.model})`,
      )
    }
  }

  setReasoningEffort(effort: string): void {
    this.reasoningEffort = effort
  }

  setThinking(mode: 'enabled' | 'disabled'): void {
    this.thinking = mode
  }

  async stream(
    request: OaiChatRequest,
    callbacks: StreamCallbacks,
    signal?: AbortSignal,
  ): Promise<void> {
    const body = buildDeepSeekResponsesBody(
      { ...request, model: this.config.model, max_tokens: request.max_tokens ?? this.config.maxTokens },
      { reasoningEffort: this.reasoningEffort, thinking: this.thinking },
    )

    await withStructuredRetry(async () => {
      const lifecycle = new AbortController()
      if (signal) {
        if (signal.aborted) lifecycle.abort()
        else signal.addEventListener('abort', () => lifecycle.abort(), { once: true })
      }
      const base = this.config.baseUrl.replace(/\/+$/, '').replace(/\/v1$/, '')
      const url = `${base}/responses`
      const response = await fetchWithTimeout(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${this.config.apiKey}`,
          Accept: 'text/event-stream',
          ...(this.config.sessionId ? { 'X-Session-Id': this.config.sessionId } : {}),
        },
        body: JSON.stringify(body),
        signal: lifecycle.signal,
      }, 180_000)

      if (!response.ok) {
        const errorBody = await response.text().catch(() => '')
        const err = Object.assign(
          new Error(`DeepSeek Responses API error (${response.status}): ${errorBody}`),
          { status: response.status },
        )
        const retryAfter = response.headers.get('retry-after')
        if (retryAfter) {
          const ms = parseRetryAfterMs(retryAfter)
          if (ms !== undefined) (err as { retryAfterMs?: number }).retryAfterMs = ms
        }
        throw err
      }

      if (!response.body) throw new Error('DeepSeek Responses API returned empty body')
      const reader = response.body.getReader()
      wireAbortToReaderCancel(lifecycle.signal, reader)
      try {
        await this.processSSE(reader, callbacks)
      } catch (err) {
        throw wrapBodyTimeoutError(err)
      } finally {
        lifecycle.abort()
      }
    }, { signal, label: 'deepseek-responses' })
  }

  private async processSSE(
    reader: ReadableStreamDefaultReader<Uint8Array>,
    callbacks: StreamCallbacks,
  ): Promise<void> {
    const decoder = new TextDecoder()
    let buffer = ''
    let currentEvent = ''
    const blocks: ContentBlock[] = []
    let textAcc = ''
    let thinkingAcc = ''
    const toolCalls = new Map<string, { id: string; name: string; arguments: string }>()

    const flushEvent = (event: string, data: string) => {
      if (!data || data === '[DONE]') return
      let parsed: Record<string, unknown>
      try {
        parsed = JSON.parse(data) as Record<string, unknown>
      } catch {
        return
      }

      if (event === 'response.output_text.delta' || event.endsWith('output_text.delta')) {
        const delta = typeof parsed.delta === 'string' ? parsed.delta
          : typeof (parsed as { text?: string }).text === 'string' ? (parsed as { text: string }).text
          : ''
        if (delta) {
          textAcc += delta
          callbacks.onTextDelta(delta)
        }
        return
      }
      if (event.includes('reasoning') && event.includes('delta')) {
        const delta = typeof parsed.delta === 'string' ? parsed.delta
          : typeof (parsed as { text?: string }).text === 'string' ? (parsed as { text: string }).text
          : ''
        if (delta) {
          thinkingAcc += delta
          callbacks.onThinkingDelta(delta)
        }
        return
      }
      if (event.includes('function_call') && event.includes('arguments') && event.includes('delta')) {
        const callId = String(parsed.call_id ?? parsed.item_id ?? 'call')
        const name = typeof parsed.name === 'string' ? parsed.name : ''
        const argsDelta = typeof parsed.delta === 'string' ? parsed.delta : ''
        const existing = toolCalls.get(callId) ?? { id: callId, name, arguments: '' }
        if (name) existing.name = name
        existing.arguments += argsDelta
        toolCalls.set(callId, existing)
        return
      }
      if (event === 'response.completed' || event === 'response.incomplete') {
        const response = (parsed.response ?? parsed) as Record<string, unknown>
        const usage = response.usage as Record<string, unknown> | undefined
        if (usage) {
          callbacks.onUsage?.({
            input_tokens: Number(usage.input_tokens ?? 0),
            output_tokens: Number(usage.output_tokens ?? 0),
            cache_read_input_tokens: Number(
              (usage.input_tokens_details as Record<string, unknown> | undefined)?.cached_tokens ?? 0,
            ),
            cache_creation_input_tokens: 0,
            reasoning_tokens: extractReasoningTokens(usage),
          })
        }
        if (thinkingAcc) {
          blocks.push({ type: 'thinking', thinking: thinkingAcc })
        }
        if (textAcc) {
          blocks.push({ type: 'text', text: textAcc })
        }
        for (const tc of toolCalls.values()) {
          let input: Record<string, unknown> = {}
          try { input = JSON.parse(tc.arguments || '{}') as Record<string, unknown> } catch { /* keep {} */ }
          blocks.push({ type: 'tool_use', id: tc.id, name: tc.name, input })
        }
        if (blocks.length > 0) callbacks.onContentBlock(blocks)
        callbacks.onStopReason(toolCalls.size > 0 ? 'tool_use' : 'end_turn')
      }
      if (event === 'response.failed') {
        const err = parsed.error as { message?: string } | undefined
        callbacks.onError(new Error(err?.message ?? 'DeepSeek Responses failed'))
      }
    }

    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      buffer += decoder.decode(value, { stream: true })
      const lines = buffer.split('\n')
      buffer = lines.pop() ?? ''
      for (const line of lines) {
        if (line.startsWith('event:')) {
          currentEvent = line.slice(6).trim()
        } else if (line.startsWith('data:')) {
          flushEvent(currentEvent, line.slice(5).trim())
          currentEvent = ''
        } else if (line.trim() === '') {
          currentEvent = ''
        }
      }
    }
  }
}
