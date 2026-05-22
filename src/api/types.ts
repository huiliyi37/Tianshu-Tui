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

/**
 * @deprecated Migration in progress — new code should use OaiMessage from src/api/oai-types.ts.
 * The legacy ContentBlock-based Message format will be removed in Phase 5.
 */
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
  cache_control?: { type: 'ephemeral' }
}

export interface SystemBlock {
  type: 'text'
  text: string
  cache_control?: { type: 'ephemeral' }
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
  /** Provider-native tool shape (e.g. GLM web_search). If set, bypasses standard function tool format. */
  providerFormat?: Record<string, unknown>
}

export interface MessageRequest {
  model: string
  messages: Message[]
  max_tokens: number
  system?: string | SystemBlock[]
  tools?: ToolDefinition[]
  tool_choice?: { type: 'auto' } | { type: 'any' } | { type: 'tool'; name: string }
  thinking?: { type: 'enabled'; budget_tokens: number } | { type: 'disabled' }
  stream?: boolean
  temperature?: number
}

export interface Usage {
  input_tokens: number
  output_tokens: number
  cache_read_input_tokens: number
  cache_creation_input_tokens: number
}

export type StreamEvent =
  | { type: 'message_start'; message: { usage?: Partial<Usage> } }
  | { type: 'content_block_start'; content_block: { type: string; [key: string]: unknown } }
  | { type: 'content_block_delta'; delta: { type: string; text?: string; thinking?: string; partial_json?: string } }
  | { type: 'content_block_stop' }
  | { type: 'message_delta'; delta: { stop_reason: string }; usage?: Partial<Usage> }
  | { type: 'message_stop' }
  | { type: 'error'; error: { type: string; message: string } }
