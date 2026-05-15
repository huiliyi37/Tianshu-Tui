import type { Message, ContentBlock, Usage } from '../api/types.js'
import { estimateMessageTokens, estimateTokens } from '../compact/micro.js'

export const EMPTY_USAGE: Usage = {
  input_tokens: 0,
  output_tokens: 0,
  cache_read_input_tokens: 0,
  cache_creation_input_tokens: 0,
}

export interface SessionState {
  messages: Message[]
  totalUsage: Usage
  turnCount: number
  startTime: number
  estimatedTokens: number
}

export class SessionContext {
  private state: SessionState

  constructor() {
    this.state = {
      messages: [],
      totalUsage: { ...EMPTY_USAGE },
      turnCount: 0,
      startTime: Date.now(),
      estimatedTokens: 0,
    }
  }

  addUserMessage(content: string): void {
    const message: Message = { role: 'user', content }
    this.state.messages.push(message)
    this.state.estimatedTokens += estimateMessageTokens(message)
    this.state.turnCount++
  }

  /** Replace all messages (used after compaction) */
  replaceMessages(messages: Message[]): void {
    this.state.messages = messages
    this.state.estimatedTokens = estimateTokens(messages)
  }

  /** Load messages from a persisted session (used on startup recovery) */
  loadMessages(messages: Message[]): void {
    this.state.messages = messages
    this.state.turnCount = messages.filter(m => m.role === 'user' && typeof m.content === 'string').length
    this.state.estimatedTokens = estimateTokens(messages)
  }

  /** Add an assistant message with structured content blocks */
  addAssistantBlocks(blocks: ContentBlock[]): void {
    const message: Message = { role: 'assistant', content: blocks }
    this.state.messages.push(message)
    this.state.estimatedTokens += estimateMessageTokens(message)
  }

  /** Add a user message with tool_result blocks (used for tool_use loopback) */
  addToolResults(results: ContentBlock[]): void {
    const message: Message = { role: 'user', content: results }
    this.state.messages.push(message)
    this.state.estimatedTokens += estimateMessageTokens(message)
  }

  addUsage(usage: Partial<Usage>): void {
    const u = this.state.totalUsage
    if (usage.input_tokens) u.input_tokens += usage.input_tokens
    if (usage.output_tokens) u.output_tokens += usage.output_tokens
    if (usage.cache_read_input_tokens) u.cache_read_input_tokens += usage.cache_read_input_tokens
    if (usage.cache_creation_input_tokens) u.cache_creation_input_tokens += usage.cache_creation_input_tokens
  }

  getCacheHitRate(): number {
    const total = this.state.totalUsage.cache_read_input_tokens + this.state.totalUsage.cache_creation_input_tokens
    return total === 0 ? 0 : this.state.totalUsage.cache_read_input_tokens / total
  }

  getMessages(): Message[] {
    return this.state.messages
  }

  getTurnCount(): number {
    return this.state.turnCount
  }

  getTotalUsage(): Usage {
    return { ...this.state.totalUsage }
  }

  getEstimatedTokens(): number {
    return this.state.estimatedTokens
  }

  getElapsedMs(): number {
    return Date.now() - this.state.startTime
  }
}
