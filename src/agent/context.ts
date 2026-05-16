import type { Message, ContentBlock, Usage } from '../api/types.js'
import type { CompactEvent, ContextLedger } from '../context/types.js'
import { estimateMessageTokens, estimateTokens } from '../compact/micro.js'

const MAX_TRACKED_FILES = 500
const MAX_TEST_RESULTS = 500
const MAX_CACHE_HISTORY = 500

export const EMPTY_USAGE: Usage = {
  input_tokens: 0,
  output_tokens: 0,
  cache_read_input_tokens: 0,
  cache_creation_input_tokens: 0,
}

export interface TurnCacheSnapshot {
  turn: number
  cacheRead: number
  cacheCreation: number
  inputTokens: number
  outputTokens: number
}

export interface SessionState {
  messages: Message[]
  totalUsage: Usage
  turnCount: number
  startTime: number
  estimatedTokens: number
  filesRead: Set<string>
  filesModified: Set<string>
  testResults: Array<{ passed: number; failed: number }>
  turnCacheHistory: TurnCacheSnapshot[]
  compactedAtTurns: Set<number>
  contextLedger?: ContextLedger
  compactEvents: CompactEvent[]
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
      filesRead: new Set(),
      filesModified: new Set(),
      testResults: [],
      turnCacheHistory: [],
      compactedAtTurns: new Set(),
      compactEvents: [],
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

  getLatestTurnHitRate(): number | null {
    const latest = this.state.turnCacheHistory[this.state.turnCacheHistory.length - 1]
    if (!latest) return null
    const total = latest.cacheRead + latest.cacheCreation
    return total > 0 ? latest.cacheRead / total : null
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

  trackFileRead(path: string): void {
    if (this.state.filesRead.has(path)) {
      this.state.filesRead.delete(path)
    }
    this.state.filesRead.add(path)
    while (this.state.filesRead.size > MAX_TRACKED_FILES) {
      const first = this.state.filesRead.values().next().value
      if (first !== undefined) this.state.filesRead.delete(first)
    }
  }

  trackFileModified(path: string): void {
    if (this.state.filesModified.has(path)) {
      this.state.filesModified.delete(path)
    }
    this.state.filesModified.add(path)
    while (this.state.filesModified.size > MAX_TRACKED_FILES) {
      const first = this.state.filesModified.values().next().value
      if (first !== undefined) this.state.filesModified.delete(first)
    }
  }

  trackTestResult(passed: number, failed: number): void {
    this.state.testResults.push({ passed, failed })
    if (this.state.testResults.length > MAX_TEST_RESULTS) {
      this.state.testResults = this.state.testResults.slice(-MAX_TEST_RESULTS)
    }
  }

  getFilesRead(): string[] {
    return [...this.state.filesRead].sort()
  }

  getFilesModified(): string[] {
    return [...this.state.filesModified].sort()
  }

  getTestResults(): Array<{ passed: number; failed: number }> {
    return this.state.testResults
  }

  recordTurnCache(turn: number, usage: Usage): void {
    this.state.turnCacheHistory.push({
      turn,
      cacheRead: usage.cache_read_input_tokens,
      cacheCreation: usage.cache_creation_input_tokens,
      inputTokens: usage.input_tokens,
      outputTokens: usage.output_tokens,
    })
    if (this.state.turnCacheHistory.length > MAX_CACHE_HISTORY) {
      this.state.turnCacheHistory = this.state.turnCacheHistory.slice(-MAX_CACHE_HISTORY)
    }
  }

  markCompacted(turn: number): void {
    this.state.compactedAtTurns.add(turn)
  }

  wasCompactedAt(turn: number): boolean {
    return this.state.compactedAtTurns.has(turn)
  }

  getCacheHistory(): TurnCacheSnapshot[] {
    return this.state.turnCacheHistory
  }

  getElapsedMs(): number {
    return Date.now() - this.state.startTime
  }

  setContextLedger(ledger: ContextLedger): void {
    this.state.contextLedger = ledger
  }

  getContextLedger(): ContextLedger | undefined {
    return this.state.contextLedger
  }

  recordCompactEvent(event: CompactEvent): void {
    this.state.compactEvents = [...this.state.compactEvents, event]
    if (this.state.compactEvents.length > MAX_CACHE_HISTORY) {
      this.state.compactEvents = this.state.compactEvents.slice(-MAX_CACHE_HISTORY)
    }
  }

  getCompactEvents(): CompactEvent[] {
    return [...this.state.compactEvents]
  }

  getWorkingSet(): string[] {
    return [...new Set([...this.state.filesRead, ...this.state.filesModified])]
  }
}
