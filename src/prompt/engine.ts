import type { ContentBlock, Message, MessageRequest } from '../api/types.js'
import { buildSystemPrompt, type StaticPromptContext } from './static.js'
import { buildVolatileBlock, type VolatileContext } from './volatile.js'
import {
  computeFingerprint,
  detectDrift,
  type PrefixFingerprint,
  type DriftEvent,
} from './fingerprint.js'

export type { PrefixFingerprint, DriftEvent }

export interface PromptEngineConfig {
  model: string
  maxTokens: number
  staticCtx: StaticPromptContext
  volatileCtx: VolatileContext
}

function isToolUseBlock(block: ContentBlock): block is ContentBlock & { type: 'tool_use'; id: string } {
  return block.type === 'tool_use'
}

function isToolResultBlock(block: ContentBlock): block is ContentBlock & { type: 'tool_result'; tool_use_id: string } {
  return block.type === 'tool_result'
}

function toolUseIds(message: Message): string[] {
  if (message.role !== 'assistant' || !Array.isArray(message.content)) return []
  return message.content.filter(isToolUseBlock).map(block => block.id)
}

function toolResultIds(message: Message | undefined): string[] {
  if (!message || message.role !== 'user' || !Array.isArray(message.content)) return []
  return message.content.filter(isToolResultBlock).map(block => block.tool_use_id)
}

function makeSyntheticToolResult(id: string): ContentBlock {
  return {
    type: 'tool_result',
    tool_use_id: id,
    content: 'Tool result unavailable: recovered from interrupted tool execution.',
    is_error: true,
  }
}

function normalizeToolResultPairs(messages: Message[]): Message[] {
  const normalized: Message[] = []

  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i]!
    if (msg.role === 'user' && Array.isArray(msg.content) && msg.content.some(isToolResultBlock)) {
      const previous = normalized[normalized.length - 1]
      if (!previous || toolUseIds(previous).length === 0) continue
    }

    normalized.push(msg)

    const ids = toolUseIds(msg)
    if (ids.length === 0) continue

    const next = messages[i + 1]
    const results = toolResultIds(next)
    const missing = ids.filter(id => !results.includes(id))
    if (missing.length > 0) {
      normalized.push({ role: 'user', content: missing.map(makeSyntheticToolResult) })
    }
  }

  return normalized
}

export class PromptEngine {
  private systemPrompt: string
  private fingerprint: PrefixFingerprint
  private config: PromptEngineConfig

  constructor(config: PromptEngineConfig) {
    this.config = config
    this.systemPrompt = buildSystemPrompt(config.staticCtx)
    // Freeze the prefix fingerprint at construction time — this is the cache anchor
    this.fingerprint = computeFingerprint(this.systemPrompt, config.staticCtx.tools)
  }

  /**
   * Build a request. Volatile context is injected as an independent user message
   * prepended before each user message with string content. This produces a
   * consistent prefix structure every turn, which is crucial for DeepSeek since
   * it ignores cache_control: ephemeral on system blocks.
   *
   * Turn 1: [system, user(<context>), user("hello")]
   * Turn 2: [system, user(<context>), user("hello"), assistant, user(<context>), user("read")]
   *
   * User messages with ContentBlock[] (tool results) pass through unchanged.
   */
  buildRequest(messages: Message[]): MessageRequest {
    const volatileBlock = buildVolatileBlock(this.config.volatileCtx)
    const result: Message[] = []

    for (const msg of normalizeToolResultPairs(messages)) {
      if (msg.role === 'user' && typeof msg.content === 'string' && volatileBlock) {
        // Prepend volatile context as independent user message before user input.
        // This keeps the prefix structure identical across turns.
        result.push({ role: 'user', content: volatileBlock })
      }
      result.push(msg)
    }

    return {
      model: this.config.model,
      messages: result,
      max_tokens: this.config.maxTokens,
      system: this.systemPrompt,  // plain string, DeepSeek-compatible
      tools: this.config.staticCtx.tools.length > 0 ? this.config.staticCtx.tools : undefined,
      tool_choice: this.config.staticCtx.tools.length > 0 ? { type: 'auto' } : undefined,
      stream: true,
    }
  }

  getFingerprint(): PrefixFingerprint {
    return this.fingerprint
  }

  checkDrift(): DriftEvent | null {
    const current = computeFingerprint(this.systemPrompt, this.config.staticCtx.tools)
    return detectDrift(this.fingerprint, current)
  }

  getSystemPrompt(): string {
    return this.systemPrompt
  }
}
