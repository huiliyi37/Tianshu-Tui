import type { ContentBlock, Message, Usage } from '../api/types.js'
import type { OaiAssistantMessage, OaiMessage, OaiToolCall, OaiToolMessage } from '../api/oai-types.js'
import type { CompactEvent, ContextLedger } from '../context/types.js'
import { estimateMessageTokens, estimateTokens, estimateOaiTokens } from '../compact/micro.js'
import { stableStringify } from '../api/stable-json.js'

const MAX_TRACKED_FILES = 500
const MAX_TEST_RESULTS = 500
const MAX_CACHE_HISTORY = 500
const LEGACY_CONTENT_SHAPE = Symbol('legacyContentShape')

type LegacyContentShape = 'string' | 'blocks'
type OaiMessageWithLegacyShape = OaiMessage & { [LEGACY_CONTENT_SHAPE]?: LegacyContentShape }

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
  oaiMessages: OaiMessageWithLegacyShape[]
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

function parseToolArguments(args: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(args) as unknown
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : {}
  } catch {
    return {}
  }
}

export function legacyMessageToOaiMessages(message: Message): OaiMessageWithLegacyShape[] {
  if (typeof message.content === 'string') {
    return [{ role: message.role, content: message.content, [LEGACY_CONTENT_SHAPE]: 'string' } as OaiMessageWithLegacyShape]
  }

  if (message.role === 'user') {
    const text = message.content
      .filter(block => block.type === 'text')
      .map(block => block.text)
      .join('')
    const toolMessages: OaiToolMessage[] = message.content
      .filter((block): block is ContentBlock & { type: 'tool_result' } => block.type === 'tool_result')
      .map(block => ({ role: 'tool', tool_call_id: block.tool_use_id, content: block.content }))

    return [
      ...(text ? [{ role: 'user' as const, content: text, [LEGACY_CONTENT_SHAPE]: 'blocks' as const } as OaiMessageWithLegacyShape] : []),
      ...toolMessages,
    ]
  }

  const text = message.content
    .filter(block => block.type === 'text')
    .map(block => block.text)
    .join('')
  const reasoning = message.content
    .filter(block => block.type === 'thinking')
    .map(block => block.thinking)
    .join('')
  const toolCalls: OaiToolCall[] = message.content
    .filter((block): block is ContentBlock & { type: 'tool_use' } => block.type === 'tool_use')
    .map(block => ({
      id: block.id,
      type: 'function',
      function: {
        name: block.name,
        arguments: stableStringify(block.input),
      },
    }))

  const assistant: OaiAssistantMessage & { [LEGACY_CONTENT_SHAPE]: LegacyContentShape } = {
    role: 'assistant',
    content: text || null,
    ...(reasoning ? { reasoning_content: reasoning } : {}),
    ...(toolCalls.length > 0 ? { tool_calls: toolCalls } : {}),
    [LEGACY_CONTENT_SHAPE]: 'blocks',
  }
  return [assistant]
}

export function oaiMessageToLegacyMessage(message: OaiMessageWithLegacyShape): Message {
  if (message.role === 'system') {
    return { role: 'user', content: message.content }
  }

  if (message.role === 'user') {
    if (message[LEGACY_CONTENT_SHAPE] === 'blocks') {
      return { role: 'user', content: [{ type: 'text', text: message.content }] }
    }
    return { role: 'user', content: message.content }
  }

  if (message.role === 'tool') {
    return {
      role: 'user',
      content: [{ type: 'tool_result', tool_use_id: message.tool_call_id, content: message.content }],
    }
  }

  if (!message.reasoning_content && !message.tool_calls && message[LEGACY_CONTENT_SHAPE] !== 'blocks') {
    return { role: 'assistant', content: message.content ?? '' }
  }

  const blocks: ContentBlock[] = []
  if (message.reasoning_content) {
    blocks.push({ type: 'thinking', thinking: message.reasoning_content })
  }
  if (message.content) {
    blocks.push({ type: 'text', text: message.content })
  }
  for (const call of message.tool_calls ?? []) {
    blocks.push({
      type: 'tool_use',
      id: call.id,
      name: call.function.name,
      input: parseToolArguments(call.function.arguments),
    })
  }

  return { role: 'assistant', content: blocks }
}

export class SessionContext {
  private state: SessionState

  constructor() {
    this.state = {
      oaiMessages: [],
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
    const message: OaiMessageWithLegacyShape = { role: 'user', content, [LEGACY_CONTENT_SHAPE]: 'string' }
    this.state.oaiMessages.push(message)
    this.state.estimatedTokens += estimateMessageTokens(oaiMessageToLegacyMessage(message))
    this.state.turnCount++
  }

  /** Replace all messages (used after compaction) */
  replaceMessages(messages: Message[]): void {
    this.state.oaiMessages = messages.flatMap(legacyMessageToOaiMessages)
    this.state.estimatedTokens = estimateTokens(messages)
  }

  /** Replace messages using OAI format directly (avoids legacy round-trip) */
  replaceOaiMessages(messages: OaiMessage[]): void {
    this.state.oaiMessages = messages
    this.state.estimatedTokens = estimateOaiTokens(messages)
  }

  /** Load messages from a persisted session (used on startup recovery) */
  loadMessages(messages: Message[]): void {
    this.state.oaiMessages = messages.flatMap(legacyMessageToOaiMessages)
    this.state.turnCount = messages.filter(m => m.role === 'user' && typeof m.content === 'string').length
    this.state.estimatedTokens = estimateTokens(messages)
  }

  /** Add an assistant message with structured content blocks */
  addAssistantBlocks(blocks: ContentBlock[]): void {
    const legacy: Message = { role: 'assistant', content: blocks }
    this.state.oaiMessages.push(...legacyMessageToOaiMessages(legacy))
    this.state.estimatedTokens += estimateMessageTokens(legacy)
  }

  /** Add a user message with tool_result blocks (used for tool_use loopback) */
  addToolResults(results: ContentBlock[]): void {
    const legacy: Message = { role: 'user', content: results }
    this.state.oaiMessages.push(...legacyMessageToOaiMessages(legacy))
    this.state.estimatedTokens += estimateMessageTokens(legacy)
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

  getRecentTurnHitRate(lastN: number): number | null {
    const slice = this.state.turnCacheHistory.slice(-lastN)
    if (slice.length === 0) return null
    let totalRead = 0
    let totalCache = 0
    for (const t of slice) {
      totalRead += t.cacheRead
      totalCache += t.cacheRead + t.cacheCreation
    }
    return totalCache > 0 ? totalRead / totalCache : null
  }

  getMessages(): Message[] {
    return this.state.oaiMessages.map(oaiMessageToLegacyMessage)
  }

  getOaiMessages(): OaiMessage[] {
    return this.state.oaiMessages.map(message => {
      const { [LEGACY_CONTENT_SHAPE]: _legacyContentShape, ...publicMessage } = message
      return publicMessage as OaiMessage
    })
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

  getWorkingSet(): string[] {
    return [...new Set([...this.state.filesRead, ...this.state.filesModified])].sort()
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
    return [...this.state.turnCacheHistory]
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
}
