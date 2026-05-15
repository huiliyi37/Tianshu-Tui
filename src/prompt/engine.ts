import type { Message, MessageRequest } from '../api/types.js'
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

    for (const msg of messages) {
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
