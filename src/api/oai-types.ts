/** OpenAI function call in assistant message. */
export interface OaiToolCall {
  id: string
  type: 'function'
  function: {
    name: string
    /** JSON string. */
    arguments: string
  }
}

/** System message. */
export interface OaiSystemMessage {
  role: 'system'
  content: string
}

/** User message. */
export interface OaiUserMessage {
  role: 'user'
  content: string
}

/** Assistant message, optionally including tool calls and provider reasoning. */
export interface OaiAssistantMessage {
  role: 'assistant'
  content: string | null
  tool_calls?: OaiToolCall[]
  /** Provider reasoning content. Stored locally; stripped before sending to DeepSeek (400 if present). */
  reasoning_content?: string
}

/** Tool result message. */
export interface OaiToolMessage {
  role: 'tool'
  tool_call_id: string
  content: string
}

export type OaiMessage =
  | OaiSystemMessage
  | OaiUserMessage
  | OaiAssistantMessage
  | OaiToolMessage

export function isToolMessage(msg: OaiMessage): msg is OaiToolMessage {
  return msg.role === 'tool'
}

export function isAssistantWithTools(msg: OaiMessage): msg is OaiAssistantMessage & { tool_calls: OaiToolCall[] } {
  return msg.role === 'assistant'
    && Array.isArray(msg.tool_calls)
    && msg.tool_calls.length > 0
}

export function isUserMessage(msg: OaiMessage): msg is OaiUserMessage {
  return msg.role === 'user'
}

/** Tool definition in OpenAI function calling format. */
export interface OaiToolDefinition {
  type: 'function'
  function: {
    name: string
    description: string
    parameters: Record<string, unknown>
    /** Provider-specific configuration (e.g. GLM web_search native integration). */
    providerFormat?: Record<string, unknown>
  }
}

/** Request body for OpenAI-compatible Chat Completions APIs. */
export interface OaiChatRequest {
  model: string
  messages: OaiMessage[]
  tools?: OaiToolDefinition[]
  tool_choice?: 'auto' | 'none' | { type: 'function'; function: { name: string } }
  max_tokens?: number
  stream?: boolean
  stream_options?: { include_usage?: boolean }
  temperature?: number
  /** DeepSeek extension. */
  reasoning_effort?: 'low' | 'medium' | 'high' | 'max'
}

/** Usage stats from OpenAI-compatible API responses. */
export interface OaiUsage {
  prompt_tokens: number
  completion_tokens: number
  prompt_cache_hit_tokens?: number
  prompt_cache_miss_tokens?: number
}
