import type { Message, ContentBlock, Usage } from '../api/types.js'

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
}

export class SessionContext {
  private state: SessionState

  constructor() {
    this.state = {
      messages: [],
      totalUsage: { ...EMPTY_USAGE },
      turnCount: 0,
      startTime: Date.now(),
    }
  }

  addUserMessage(content: string): void {
    this.state.messages.push({ role: 'user', content })
    this.state.turnCount++
  }

  /** Add an assistant message with structured content blocks */
  addAssistantBlocks(blocks: ContentBlock[]): void {
    this.state.messages.push({ role: 'assistant', content: blocks })
  }

  /** Add a user message with tool_result blocks (used for tool_use loopback) */
  addToolResults(results: ContentBlock[]): void {
    this.state.messages.push({ role: 'user', content: results })
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

  getElapsedMs(): number {
    return Date.now() - this.state.startTime
  }
}
