/**
 * DeepSeek Responses API 请求体适配（双栈：Chat Completions ↔ Responses）。
 *
 * 官方限制（2026-08）：Responses 目前仅 `deepseek-v4-flash`；effort 走
 * `reasoning.effort`（none/low/medium/high/max），与 Chat 的 reasoning_effort
 * 字段不同。本模块只负责 body 变换与能力门闩，流式解析复用 Codex 同形 SSE。
 */

import type { OaiChatRequest, OaiMessage, OaiToolDefinition } from './oai-types.js'
import { mapDeepSeekResponsesEffort, stripThinkingSamplingFields } from './deepseek-effort.js'

export const DEEPSEEK_RESPONSES_SUPPORTED_MODELS = new Set(['deepseek-v4-flash'])

export function supportsDeepSeekResponses(model: string): boolean {
  return DEEPSEEK_RESPONSES_SUPPORTED_MODELS.has(model)
}

/** 是否启用 DeepSeek Responses 双栈（显式 protocol 或环境变量）。 */
export function isDeepSeekResponsesEnabled(
  protocol: string | undefined,
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  if (protocol === 'responses') return true
  const raw = env['RIVET_DEEPSEEK_RESPONSES']
  if (raw === undefined || raw === '') return false
  const v = raw.trim().toLowerCase()
  return v === '1' || v === 'true' || v === 'on' || v === 'yes'
}

function messageToInputItem(msg: OaiMessage): Record<string, unknown> | null {
  if (msg.role === 'system') {
    return { type: 'message', role: 'system', content: typeof msg.content === 'string' ? msg.content : '' }
  }
  if (msg.role === 'user') {
    const text = typeof msg.content === 'string'
      ? msg.content
      : msg.content.filter(p => p.type === 'text').map(p => p.text).join('')
    return { type: 'message', role: 'user', content: text }
  }
  if (msg.role === 'assistant') {
    if (msg.tool_calls && msg.tool_calls.length > 0) {
      // Responses 用 function_call 项；多 tool_call 展开为多项由调用方拼接。
      return null // handled specially
    }
    const parts: Record<string, unknown>[] = []
    if (msg.reasoning_content) {
      parts.push({
        type: 'reasoning',
        content: [{ type: 'reasoning_text', text: msg.reasoning_content }],
      })
    }
    parts.push({
      type: 'message',
      role: 'assistant',
      content: [{ type: 'output_text', text: msg.content ?? '' }],
    })
    // Return first; caller flattens arrays — we encode as single message for simplicity.
    return {
      type: 'message',
      role: 'assistant',
      content: msg.content ?? '',
      ...(msg.reasoning_content ? { _reasoning: msg.reasoning_content } : {}),
    }
  }
  if (msg.role === 'tool') {
    return {
      type: 'function_call_output',
      call_id: msg.tool_call_id,
      output: msg.content,
    }
  }
  return null
}

function expandAssistant(msg: Extract<OaiMessage, { role: 'assistant' }>): Record<string, unknown>[] {
  const items: Record<string, unknown>[] = []
  if (msg.reasoning_content) {
    items.push({
      type: 'reasoning',
      content: [{ type: 'reasoning_text', text: msg.reasoning_content }],
    })
  }
  if (msg.tool_calls && msg.tool_calls.length > 0) {
    for (const tc of msg.tool_calls) {
      items.push({
        type: 'function_call',
        call_id: tc.id,
        name: tc.function.name,
        arguments: tc.function.arguments,
      })
    }
    if (msg.content) {
      items.push({
        type: 'message',
        role: 'assistant',
        content: [{ type: 'output_text', text: msg.content }],
      })
    }
    return items
  }
  items.push({
    type: 'message',
    role: 'assistant',
    content: [{ type: 'output_text', text: msg.content ?? '' }],
  })
  return items
}

function mapTools(tools: OaiToolDefinition[] | undefined): Record<string, unknown>[] | undefined {
  if (!tools || tools.length === 0) return undefined
  return tools.map(t => ({
    type: 'function',
    name: t.function.name,
    description: t.function.description,
    parameters: t.function.parameters,
  }))
}

export interface DeepSeekResponsesBody {
  model: string
  input: unknown
  instructions?: string
  reasoning?: { effort: string }
  max_output_tokens?: number
  stream?: boolean
  tools?: Record<string, unknown>[]
  tool_choice?: unknown
  text?: { format: { type: string } }
}

/**
 * 把 Chat Completions 请求改写成 DeepSeek Responses API body。
 * thinking 开启时剥离无效采样字段。
 */
export function buildDeepSeekResponsesBody(
  request: OaiChatRequest,
  opts: {
    reasoningEffort?: string
    thinking?: 'enabled' | 'disabled'
  } = {},
): DeepSeekResponsesBody {
  const messages = request.messages
  let instructions: string | undefined
  const inputItems: Record<string, unknown>[] = []

  for (const msg of messages) {
    if (msg.role === 'system' && instructions === undefined) {
      instructions = typeof msg.content === 'string' ? msg.content : ''
      continue
    }
    if (msg.role === 'assistant') {
      inputItems.push(...expandAssistant(msg))
      continue
    }
    const item = messageToInputItem(msg)
    if (item) inputItems.push(item)
  }

  const effort = mapDeepSeekResponsesEffort(
    request.reasoning_effort ?? opts.reasoningEffort,
  )
  const thinkingOff = opts.thinking === 'disabled' || effort === 'none'

  const body: Record<string, unknown> = {
    model: request.model,
    input: inputItems.length === 1 && typeof inputItems[0] === 'object'
      && (inputItems[0] as { role?: string }).role === 'user'
      && typeof (inputItems[0] as { content?: unknown }).content === 'string'
      ? (inputItems[0] as { content: string }).content
      : inputItems,
    stream: true,
  }
  if (instructions) body.instructions = instructions
  if (!thinkingOff) {
    body.reasoning = { effort }
  } else {
    body.reasoning = { effort: 'none' }
  }
  if (request.max_tokens !== undefined) body.max_output_tokens = request.max_tokens
  const tools = mapTools(request.tools)
  if (tools) body.tools = tools
  if (request.tool_choice) body.tool_choice = request.tool_choice
  if (request.response_format?.type === 'json_object') {
    body.text = { format: { type: 'json_object' } }
  }
  // temperature 等在 thinking 下无效
  if (!thinkingOff) stripThinkingSamplingFields(body)

  return body as unknown as DeepSeekResponsesBody
}
