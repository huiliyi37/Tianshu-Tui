import type { ContentBlock, Usage } from '../api/types.js'
import type { OaiMessage, OaiToolCall, OaiContentPart } from '../api/oai-types.js'
import type { CompactEvent, ContextLedger } from '../context/types.js'
import { estimateOaiMessageTokens, estimateOaiTokens } from '../compact/micro.js'
import { stableStringify } from '../api/stable-json.js'
import { sanitizeForJsonTransport } from '../utils/sanitize.js'
import { wrapSystemReminder } from '../prompt/system-reminder.js'

import { INLINE_TOOL_RESULT_MAX_CHARS } from '../compact/constants.js'
import { ToolArgPostProcessorRegistry } from './tool-arg-post-processor.js'
import { planSubmitArgProcessor } from '../tools/plan-submit-arg-processor.js'
import { writeFileArgProcessor } from '../tools/write-file-arg-processor.js'
import { editFileArgProcessor } from '../tools/edit-file-arg-processor.js'
import { hashEditArgProcessor } from '../tools/hash-edit-arg-processor.js'
import { applyPatchArgProcessor } from '../tools/apply-patch-arg-processor.js'

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
  /** API 最近一轮请求返回的真实 prompt_tokens（校准基准）。
   *  由 addUsage() 在每轮 API 响应后写入；0 表示尚无数据。 */
  lastRealPromptTokens: number
  /** Ratio between local token estimate and the API's actual prompt_tokens
   *  from the most recent request. Applied in getEstimatedTokens() so the
   *  GlanceBar shows "current context occupancy" aligned with real API usage,
   *  not a stale single-turn value. Starts at 1 (trust local estimate). */
  contextCalibrationRatio: number
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
  /** Tool argument post-processors — intercept large args before entering oaiMessages */
  private argProcessors: ToolArgPostProcessorRegistry

  constructor() {
    this.state = {
      oaiMessages: [],
      totalUsage: { ...EMPTY_USAGE },
      turnCount: 0,
      startTime: Date.now(),
      estimatedTokens: 0,
      prefixOverhead: 0,
      lastRealPromptTokens: 0,
      contextCalibrationRatio: 1,
      filesRead: new Set(),
      filesModified: new Set(),
      testResults: [],
      turnCacheHistory: [],
      compactedAtTurns: new Set(),
      compactEvents: [],
    }
    // Register built-in arg processors
    this.argProcessors = new ToolArgPostProcessorRegistry()
    this.argProcessors.register(planSubmitArgProcessor)
    this.argProcessors.register(writeFileArgProcessor)
    this.argProcessors.register(editFileArgProcessor)
    this.argProcessors.register(hashEditArgProcessor)
    this.argProcessors.register(applyPatchArgProcessor)
  }

  /**
   * Subscribe to message-list mutations. The listener is invoked synchronously
   * after each `addUserMessage` / `addAssistantBlocks` / `addToolResults` /
   * `replaceMessages` call. Used by AgentLoop to mirror messages to disk.
   */
  setMutationListener(fn: (m: MessageMutation) => void): void {
    this.onMutation = fn
  }

  addUserMessage(content: string, images?: string[]): void {
    let msg: OaiMessage
    if (images && images.length > 0) {
      // Multimodal: construct OpenAI vision content parts (text + image_url).
      const parts: OaiContentPart[] = [
        { type: 'text', text: sanitizeForJsonTransport(content) },
        ...images.map(url => ({ type: 'image_url' as const, image_url: { url } })),
      ]
      msg = { role: 'user', content: parts }
    } else {
      msg = { role: 'user', content: sanitizeForJsonTransport(content) }
    }
    this.state.oaiMessages.push(msg)
    this.state.estimatedTokens += estimateOaiMessageTokens(msg)
    this.state.turnCount++
    this.onMutation?.({ type: 'append', message: msg })
  }

  /**
   * Inject a system-reminder as an APPEND-ONLY tail entry — never rewrite a
   * mid-array message.
   *
   * DeepSeek's exact-prefix cache keys on the token sequence, not on message
   * count. Rewriting any earlier message invalidates the prefix from that point
   * onward, collapsing every cached tool output after it. The previous version
   * scanned backwards for "the last user message" and edited it in place; during
   * a turn that message sits mid-array (assistant + tool outputs already follow
   * it), so the edit detonated the cache for the rest of the turn — the opposite
   * of its stated goal (regression 5fedd9b6).
   *
   * We only ever touch the tail:
   *   - tail is a string user message → merge into it (still append-only: the
   *     tail is the newest position, nothing is cached after it, and merging
   *     avoids producing two consecutive user messages);
   *   - otherwise (tail is assistant/tool, or non-string) → push a new SR user
   *     message at the end. The SR marker keeps PromptEngine from treating it as
   *     a real user boundary.
   */
  appendSystemReminder(text: string): void {
    const wrapped = wrapSystemReminder(text)
    const msgs = this.state.oaiMessages
    const last = msgs[msgs.length - 1]
    if (last && last.role === 'user' && typeof last.content === 'string') {
      const oldTokens = estimateOaiMessageTokens(last)
      const merged = { ...last, content: last.content + '\n' + sanitizeForJsonTransport(wrapped) }
      msgs[msgs.length - 1] = merged
      this.state.estimatedTokens += estimateOaiMessageTokens(merged) - oldTokens
      this.onMutation?.({ type: 'replace', messages: msgs.slice() })
      return
    }
    this.addUserMessage(wrapped)
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

  /**
   * Rewind-specific message replacement. Unlike {@link replaceMessages} (also
   * used by compaction, which must NOT clear derived state), this resets all
   * agent-internal tracking that referenced the removed messages after the
   * rewind point.
   */
  rewindToMessages(messages: OaiMessage[]): void {
    this.state.oaiMessages = messages
    this.state.estimatedTokens = estimateOaiTokens(messages)
    this.state.turnCount = messages.filter(m => m.role === 'user').length
    this.state.turnCacheHistory = []
    this.state.compactedAtTurns = new Set()
    this.state.filesRead = new Set()
    this.state.filesModified = new Set()
    this.onMutation?.({ type: 'replace', messages: messages.slice() })
  }

  addAssistantBlocks(blocks: ContentBlock[]): void {
    const text = blocks.filter(b => b.type === 'text').map(b => b.text).join('')
    const reasoning = blocks.filter(b => b.type === 'thinking').map(b => b.thinking).join('')
    const toolCalls: OaiToolCall[] = blocks
      .filter((b): b is ContentBlock & { type: 'tool_use' } => b.type === 'tool_use')
      .map(b => ({ id: b.id, type: 'function' as const, function: { name: b.name, arguments: stableStringify(b.input) } }))
    // Intercept large tool call arguments before they enter oaiMessages.
    // IMPORTANT: operates on the stringified arguments only — never touches b.input.
    const processedCalls = this.argProcessors.processToolCalls(toolCalls)

    const msg: OaiMessage = {
      role: 'assistant',
      content: text || (processedCalls.length === 0 ? '' : null),
      ...(reasoning ? { reasoning_content: reasoning } : {}),
      ...(processedCalls.length > 0 ? { tool_calls: processedCalls } : {}),
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
    if (usage.input_tokens) {
      u.input_tokens += usage.input_tokens
      this.state.lastRealPromptTokens = usage.input_tokens
      // Calibrate local estimate against the API's real prompt_tokens.
      // The raw estimatedTokens tracks current messages only; prefixOverhead
      // is fixed. The ratio captures provider-specific tokenization / overhead
      // so getEstimatedTokens() stays close to reality between API calls.
      const localEstimate = this.state.estimatedTokens + this.state.prefixOverhead
      if (localEstimate > 0) {
        const apiTokens = usage.input_tokens
        // Defer: when the local baseline can't explain even 10% of the API
        // report, the ratio would be wildly off (this happens before
        // ensurePrefixOverhead runs in maybeCompact on turn 1). Keep ratio=1
        // — the local estimate is conservative but won't explode.
        if (localEstimate < apiTokens * 0.1) {
          // No calibration write — ratio stays at prior value (1 initially).
        } else {
          // Clamp the raw ratio to [0.5, 5] before EMA. Tokenization
          // differences across providers are typically within 2x; 5x is a
          // generous envelope that still rejects pathological inputs.
          const rawRatio = apiTokens / localEstimate
          const ratio = Math.max(0.5, Math.min(5, rawRatio))
          // Uniform EMA α=0.7: even the first calibration is gradual, so a
          // single outlier can never permanently poison the ratio.
          this.state.contextCalibrationRatio = 0.7 * ratio + 0.3 * this.state.contextCalibrationRatio
        }
      }
    }
    if (usage.output_tokens) u.output_tokens += usage.output_tokens
    if (usage.cache_read_input_tokens) u.cache_read_input_tokens += usage.cache_read_input_tokens
    if (usage.cache_creation_input_tokens) u.cache_creation_input_tokens += usage.cache_creation_input_tokens
  }

  getCacheHitRate(): number {
    // Use total input_tokens as denominator — cache_read / (cacheRead + cacheCreation)
    // degenerates to 100% when cacheCreation is 0 (provider doesn't report miss tokens).
    const input = this.state.totalUsage.input_tokens
    return input === 0 ? 0 : Math.min(1, this.state.totalUsage.cache_read_input_tokens / input)
  }

  getLatestTurnHitRate(): number | null {
    const latest = this.state.turnCacheHistory[this.state.turnCacheHistory.length - 1]
    if (!latest) return null
    return latest.inputTokens > 0 ? Math.min(1, latest.cacheRead / latest.inputTokens) : null
  }

  getRecentTurnHitRate(lastN: number): number | null {
    const slice = this.state.turnCacheHistory.slice(-lastN)
    if (slice.length === 0) return null
    let totalRead = 0
    let totalInput = 0
    for (const t of slice) {
      totalRead += t.cacheRead
      totalInput += t.inputTokens
    }
    return totalInput > 0 ? Math.min(1, totalRead / totalInput) : null
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
    const base = this.state.estimatedTokens + this.state.prefixOverhead
    return Math.round(base * this.state.contextCalibrationRatio)
  }

  /** API 最近一轮返回的真实 prompt_tokens（校准基准）；0 表示尚无数据。 */
  getLastRealPromptTokens(): number {
    return this.state.lastRealPromptTokens
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
