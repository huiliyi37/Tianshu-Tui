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

/** Vision content parts for multimodal user messages (OpenAI image_url format). */
export interface OaiTextPart {
  type: 'text'
  text: string
}
export interface OaiImagePart {
  type: 'image_url'
  image_url: { url: string } // data:image/...;base64,... or https URL
}
export type OaiContentPart = OaiTextPart | OaiImagePart

/** User message — content is plain text or multimodal parts (vision). */
export interface OaiUserMessage {
  role: 'user'
  content: string | OaiContentPart[]
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

/**
 * Extract plain text from any OaiMessage content (handles multimodal user messages).
 * Use this instead of `msg.content` when you need a string regardless of content type.
 */
export function oaiMessageText(msg: OaiMessage): string {
  if (msg.role === 'user' && Array.isArray(msg.content)) {
    return msg.content.filter(p => p.type === 'text').map(p => p.text).join('')
  }
  return msg.content as string
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
  /** Force the model to emit valid JSON (OpenAI-compatible json_object mode).
   *  Worker sessions set this on the final (no-tools) turn to eliminate free-text
   *  parse failures. Requires the prompt to mention "json". */
  response_format?: { type: 'json_object' }
}

/** Usage stats from OpenAI-compatible API responses. */
export interface OaiUsage {
  prompt_tokens: number
  completion_tokens: number
  prompt_cache_hit_tokens?: number
  prompt_cache_miss_tokens?: number
}
