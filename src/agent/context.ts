import type { ContentBlock, Usage } from '../api/types.js'
import type { OaiMessage, OaiToolCall } from '../api/oai-types.js'
import type { CompactEvent, ContextLedger } from '../context/types.js'
import { estimateOaiMessageTokens, estimateOaiTokens } from '../compact/micro.js'
import { stableStringify } from '../api/stable-json.js'
import { sanitizeForJsonTransport } from '../utils/sanitize.js'

import { INLINE_TOOL_RESULT_MAX_CHARS } from '../compact/constants.js'

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
  oaiMessages: OaiMessage[]
  totalUsage: Usage
  turnCount: number
  startTime: number
  estimatedTokens: number
  filesRead: Set<string>
  filesModified: Set<string>
  testResults: Array<{ passed: number; failed: number }>
  /** Fixed overhead from system prompt, tool schemas, and static blocks
   *  that are not reflected in per-message token estimates. Set by the
   *  prompt engine after the first request build. */
  prefixOverhead: number
  turnCacheHistory: TurnCacheSnapshot[]
  compactedAtTurns: Set<number>
  contextLedger?: ContextLedger
  compactEvents: CompactEvent[]
}

/**
 * Notification emitted whenever the in-memory message list changes. A listener
 * can subscribe via {@link SessionContext.setMutationListener} to mirror the
 * change to durable storage.
 *
 * - `append`: a single message was just pushed onto `oaiMessages`.
 * - `replace`: the message array was wholesale replaced (compaction / reset).
 */
export type MessageMutation =
  | { type: 'append'; message: OaiMessage }
  | { type: 'replace'; messages: OaiMessage[] }

export class SessionContext {
  private state: SessionState
  private onMutation: ((m: MessageMutation) => void) | null = null

  constructor() {
    this.state = {
      oaiMessages: [],
      totalUsage: { ...EMPTY_USAGE },
      turnCount: 0,
      startTime: Date.now(),
      estimatedTokens: 0,
      prefixOverhead: 0,
      filesRead: new Set(),
      filesModified: new Set(),
      testResults: [],
      turnCacheHistory: [],
      compactedAtTurns: new Set(),
      compactEvents: [],
    }
  }

  /**
   * Subscribe to message-list mutations. The listener is invoked synchronously
   * after each `addUserMessage` / `addAssistantBlocks` / `addToolResults` /
   * `replaceMessages` call. Used by AgentLoop to mirror messages to disk.
   */
  setMutationListener(fn: (m: MessageMutation) => void): void {
    this.onMutation = fn
  }

  addUserMessage(content: string): void {
    const msg: OaiMessage = { role: 'user', content: sanitizeForJsonTransport(content) }
    this.state.oaiMessages.push(msg)
    this.state.estimatedTokens += estimateOaiMessageTokens(msg)
    this.state.turnCount++
    this.onMutation?.({ type: 'append', message: msg })
  }

  /**
   * Remove the most recently appended message. Used to roll back a user
   * message when the turn is aborted or fails before any assistant response
   * is produced. Returns the removed message, or `undefined` if the session
   * is empty.
   */
  removeLastMessage(): OaiMessage | undefined {
    const msg = this.state.oaiMessages.pop()
    if (msg) {
      if (msg.role !== 'user') {
        // Put the message back — this method is contractually for user-message
        // rollback only. Non-user removal indicates a caller bug.
        this.state.oaiMessages.push(msg)
        throw new Error(
          `removeLastMessage: expected user message but top was ${msg.role}. ` +
          'This method may only be used to roll back user messages on abort/error.',
        )
      }
      this.state.estimatedTokens -= estimateOaiMessageTokens(msg)
      this.state.turnCount--
      // Emit a replace mutation so the persistence layer rewrites the file
      // without the removed message. We use 'replace' (full rewrite) rather
      // than a hypothetical 'remove' type because the persistence listener
      // already handles 'replace' → compactOai(), and removals only happen
      // on abort/error (rare, not performance-sensitive).
      this.onMutation?.({ type: 'replace', messages: this.state.oaiMessages.slice() })
    }
    return msg
  }

  replaceMessages(messages: OaiMessage[]): void {
    this.state.oaiMessages = messages
    this.state.estimatedTokens = estimateOaiTokens(messages)
    // Snapshot the array so subsequent mutations to state.oaiMessages don't
    // bleed into a listener's deferred work (e.g. async disk write).
    this.onMutation?.({ type: 'replace', messages: messages.slice() })
  }

  addAssistantBlocks(blocks: ContentBlock[]): void {
    const text = blocks.filter(b => b.type === 'text').map(b => b.text).join('')
    const reasoning = blocks.filter(b => b.type === 'thinking').map(b => b.thinking).join('')
    const toolCalls: OaiToolCall[] = blocks
      .filter((b): b is ContentBlock & { type: 'tool_use' } => b.type === 'tool_use')
      .map(b => ({ id: b.id, type: 'function' as const, function: { name: b.name, arguments: stableStringify(b.input) } }))

    const msg: OaiMessage = {
      role: 'assistant',
      content: text || (toolCalls.length === 0 ? '' : null),
      ...(reasoning ? { reasoning_content: reasoning } : {}),
      ...(toolCalls.length > 0 ? { tool_calls: toolCalls } : {}),
    }
    this.state.oaiMessages.push(msg)
    this.state.estimatedTokens += estimateOaiMessageTokens(msg)
    this.onMutation?.({ type: 'append', message: msg })
  }

  addToolResults(results: ContentBlock[]): void {
    for (const block of results) {
      if (block.type === 'tool_result') {
        const trimmed = sanitizeForJsonTransport(trimToolResultForMemory(block.content))
        const msg: OaiMessage = { role: 'tool', tool_call_id: block.tool_use_id, content: trimmed }
        this.state.oaiMessages.push(msg)
        this.state.estimatedTokens += estimateOaiMessageTokens(msg)
        this.onMutation?.({ type: 'append', message: msg })
      }
    }
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

  getMessages(): OaiMessage[] {
    return this.state.oaiMessages
  }

  getTurnCount(): number {
    return this.state.turnCount
  }

  getTotalUsage(): Usage {
    return { ...this.state.totalUsage }
  }

  getEstimatedTokens(): number {
    return this.state.estimatedTokens + this.state.prefixOverhead
  }

  /** Set the fixed token overhead from system prompt, tool schemas, static blocks. */
  setPrefixOverhead(tokens: number): void {
    this.state.prefixOverhead = tokens
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

// ─── Memory-safety helpers ───────────────────────────────────────

/** Artifact marker pattern: "[artifact:ID]" at end of content. */
const ARTIFACT_MARKER_REGEX = /\[artifact:([A-Za-z0-9_-]+)\]\s*$/

/**
 * Trim tool result content that exceeds {@link INLINE_TOOL_RESULT_MAX_CHARS}.
 * Preserves the artifact marker so the model can still recover full content
 * via read_section. Full content remains on disk — this only bounds JS heap usage.
 */
function trimToolResultForMemory(content: string): string {
  if (content.length <= INLINE_TOOL_RESULT_MAX_CHARS) return content

  const artifactMatch = content.match(ARTIFACT_MARKER_REGEX)
  const marker = artifactMatch ? artifactMatch[0] : ''
  const markerLen = marker.length

  // Reserve space for the marker + the memory-trimmed tag
  const tagOverhead = `<memory-trimmed original_chars="${content.length}" />\n`.length
  const keepChars = Math.max(0, INLINE_TOOL_RESULT_MAX_CHARS - markerLen - tagOverhead)
  const truncated = content.slice(0, keepChars)

  const memoryTag = `<memory-trimmed original_chars="${content.length}" kept_chars="${keepChars}" />`

  if (artifactMatch) {
    return truncated + '\n' + memoryTag + '\n' + marker
  }
  return truncated + '\n' + memoryTag
}
