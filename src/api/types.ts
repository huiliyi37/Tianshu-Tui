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
