export type {
  OaiAssistantMessage,
  OaiChatRequest,
  OaiMessage,
  OaiSystemMessage,
  OaiToolCall,
  OaiToolDefinition,
  OaiToolMessage,
  OaiUsage,
  OaiUserMessage,
} from './oai-types.js'

export interface ContentBlockText {
  type: 'text'
  text: string
}

export interface ContentBlockThinking {
  type: 'thinking'
  thinking: string
}

export interface ContentBlockToolUse {
  type: 'tool_use'
  id: string
  name: string
  input: Record<string, unknown>
  /**
   * Set when the stream ended while this call's arguments were still
   * incomplete/unparseable (final-flush-empty). `input` is {} in that case —
   * NOT what the model asked for. The tool pipeline must refuse to execute
   * the call and return an error result instead (session 4df36bcd: a
   * truncated bash call executed with {} and threw deep inside the sandbox
   * wrapper).
   */
  argsTruncated?: boolean
}

export interface ContentBlockToolResult {
  type: 'tool_result'
  tool_use_id: string
  content: string
  is_error?: boolean
}

export type ContentBlock =
  | ContentBlockText
  | ContentBlockThinking
  | ContentBlockToolUse
  | ContentBlockToolResult

export interface Message {
  role: 'user' | 'assistant'
  content: string | ContentBlock[]
}

export interface ToolDefinition {
  name: string
  description: string
  input_schema?: {
    type: 'object'
    properties: Record<string, unknown>
    required?: string[]
    additionalProperties?: boolean
  }
  providerFormat?: Record<string, unknown>
}

export interface Usage {
  /**
   * Total prompt tokens, cache-INCLUSIVE: input_tokens = uncached + cache_read
   * + cache_creation. This is DeepSeek/OpenAI native semantics (prompt_tokens
   * = hit + miss). Clients whose upstream reports cache-EXCLUSIVE input
   * (Anthropic) must normalize at the boundary before emitting Usage.
   * Consumers (hit rate, cost, meta tokenUsage) all assume this convention.
   */
  input_tokens: number
  output_tokens: number
  cache_read_input_tokens: number
  cache_creation_input_tokens: number
  /**
   * Reasoning/thinking tokens, a subset of output_tokens (NOT additive).
   * Optional: only thinking-capable providers report it (DeepSeek V4 via
   * completion_tokens_details.reasoning_tokens, etc.). Undefined when the
   * provider does not surface the split. Text tokens = output_tokens - reasoning_tokens.
   */
  reasoning_tokens?: number
}
