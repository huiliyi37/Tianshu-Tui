import type { StreamClient } from '../api/stream-client.js'
import type { OaiMessage } from '../api/oai-types.js'
import { CACHE_ANCHOR_MESSAGES, summaryOutputBudgetChars } from '../compact/constants.js'
import { microCompactOai, estimateOaiTokens } from '../compact/micro.js'

import { debugLog } from '../utils/debug.js'
import { decideCompactTier, recordCompactFailure, recordCompactSuccess } from '../context/compact-policy.js'
import type { CompactCircuitBreakerState, CompactTier } from '../context/types.js'
import type { ProviderProfile } from '../api/provider-profile.js'
import { diagnoseCacheMiss } from '../prompt/cache-diagnostic.js'
import type { PromptEngine } from '../prompt/engine.js'
import type { PressureMonitor } from '../context/pressure-monitor.js'
import type { SessionContext } from './context.js'
import { extractTaskState } from './task-state.js'
import { renderTaskAnchor, type TaskContract } from '../context/task-contract.js'
import type { TrajectoryEntry } from './trajectory.js'
import type { CacheAdvisor } from '../cache/advisor.js'
import { extractSessionMemories, type ExtractedMemory } from './session-memory-extract.js'

/**
 * Extract the user intent chain: all user messages in order,
 * truncated to a reasonable preview for the compaction prompt.
 * This ensures the LLM summary preserves the user's full intent
 * evolution, including corrections and clarifications.
 */
function extractUserIntentChain(messages: OaiMessage[]): string[] {
  const MAX_PER_MESSAGE = 300
  const MAX_MESSAGES = 20

  return messages
    .filter(m => m.role === 'user')
    .slice(-MAX_MESSAGES)
    .map(m => {
      const text = (typeof m.content === 'string' ? m.content : '').trim().replace(/\n+/g, ' ')
      return text.length > MAX_PER_MESSAGE
        ? text.slice(0, MAX_PER_MESSAGE) + '...'
        : text
    })
}

/**
 * Find a safe split point that doesn't cut through a tool_calls ↔ tool group.
 *
 * The OpenAI-compatible API requires every assistant message with tool_calls
 * to be immediately followed by matching tool messages. If tryPartialCompact
 * splits between an assistant(tool_calls) and its tool results, the resulting
 * message list becomes invalid and the API returns an error.
 *
 * This function walks backward from the desired split point to ensure we
 * split only at group boundaries: a tool call group (assistant + its tool
 * results) stays together in either oldZone or recentZone, not split across.
 */
export function findSafeSplitPoint(
  messages: OaiMessage[],
  desiredSplit: number,
  minSplit: number,
): number {
  let sp = desiredSplit

  // Walk backward while the message at sp is a tool — its owning assistant
  // must be before sp, so we move sp before that assistant to keep the group intact.
  let iterations = 0
  while (sp > minSplit && sp < messages.length && messages[sp]?.role === 'tool') {
    if (++iterations > 100) break // safety valve
    const toolCallId = (messages[sp] as Record<string, unknown>).tool_call_id as string | undefined
    if (!toolCallId) break
    let found = false
    for (let i = sp - 1; i >= 0; i--) {
      const msg = messages[i]
      if (msg?.role === 'assistant') {
        const toolCalls = (msg as Record<string, unknown>).tool_calls as Array<{ id: string }> | undefined
        if (toolCalls?.some(tc => tc.id === toolCallId)) {
          sp = i // move split before the assistant that owns this tool
          found = true
          break
        }
      }
    }
    if (!found) break // orphaned tool with no matching assistant — shouldn't happen
  }

  return sp
}

export type HandoffToolStatus = TrajectoryEntry['status'] | 'running'

export interface StructuredHandoffInput {
  taskState: {
    current: string
    completed: string[]
    remaining: string[]
    decisions: string[]
  }
  turnCount: number
  filesSeen: string[]
  reasoningSnippet: string
  errorCount: number
  errors: Array<{ turn: number; tool: string; target: string; errorClass: string; summary: string }>
  toolHistory: Array<{ tool: string; target: string; status: HandoffToolStatus }>
  /** Collaboration-stance evidence derived from virtue signals. */
  stanceSummary?: string | null
}

export const STRUCTURED_HANDOFF_SECTIONS = [
  '1. 用户核心需求',
  '2. 关键技术决策',
  '3. 文件与代码',
  '4. 错误与修复',
  '5. 当前工作',
  '6. 已完成工作',
  '7. 待办事项',
  '8. 最近工具轨迹',
  '9. 下一步',
] as const

function statusLabel(status: HandoffToolStatus): string {
  if (status === 'failed' || status === 'retried-failed') return 'FAIL'
  if (status === 'retried-success') return 'ok*'
  if (status === 'running') return 'running'
  return 'ok'
}

export function buildStructuredHandoff(input: StructuredHandoffInput): string {
  const taskState = input.taskState
  const lines: string[] = [
    '<session-handoff>',
    `Turn: ${input.turnCount}`,
    '',
    `## ${STRUCTURED_HANDOFF_SECTIONS[0]}`,
    taskState.current || '（无明确记录）',
    '',
    `## ${STRUCTURED_HANDOFF_SECTIONS[1]}`,
  ]

  if (taskState.decisions.length > 0) {
    for (const decision of taskState.decisions.slice(-8)) lines.push(`- ${decision}`)
  } else {
    lines.push('（无记录）')
  }

  lines.push('', `## ${STRUCTURED_HANDOFF_SECTIONS[2]}`)
  if (input.filesSeen.length > 0) {
    for (const file of input.filesSeen.slice(0, 15)) {
      const tools = [...new Set(input.toolHistory.filter(t => t.target === file).map(t => t.tool))]
      lines.push(`- ${file}${tools.length > 0 ? ` [${tools.join(', ')}]` : ''}`)
    }
  } else {
    lines.push('（无文件记录）')
  }

  lines.push('', `## ${STRUCTURED_HANDOFF_SECTIONS[3]}`)
  if (input.errors.length > 0) {
    lines.push(`Error count: ${input.errorCount}`)
    for (const error of input.errors.slice(0, 8)) {
      lines.push(`- [Turn ${error.turn}] failed: ${error.tool} ${error.target}: ${error.summary} (${error.errorClass})`)
    }
  } else {
    lines.push('（无错误）')
  }

  lines.push('', `## ${STRUCTURED_HANDOFF_SECTIONS[4]}`)
  lines.push(taskState.current || '（无记录）')

  lines.push('', `## ${STRUCTURED_HANDOFF_SECTIONS[5]}`)
  if (taskState.completed.length > 0) {
    for (const item of taskState.completed.slice(-8)) lines.push(`- [x] ${item}`)
  } else {
    lines.push('（无记录）')
  }

  lines.push('', `## ${STRUCTURED_HANDOFF_SECTIONS[6]}`)
  if (taskState.remaining.length > 0) {
    for (const item of taskState.remaining.slice(0, 8)) lines.push(`- [ ] ${item}`)
  } else {
    lines.push('（无明确待办）')
  }

  lines.push('', `## ${STRUCTURED_HANDOFF_SECTIONS[7]}`)
  if (input.toolHistory.length > 0) {
    for (const tool of input.toolHistory.slice(-12)) {
      lines.push(`- ${tool.tool} ${tool.target} [${statusLabel(tool.status)}]`)
    }
  } else {
    lines.push('（无工具记录）')
  }

  lines.push('', `## ${STRUCTURED_HANDOFF_SECTIONS[8]}`)
  lines.push(taskState.remaining[0] ?? taskState.current ?? '继续当前任务')

  if (input.stanceSummary && input.stanceSummary.trim().length > 0) {
    lines.push('', '## 协作姿态（从行为轨迹涌现，非身份注入）')
    lines.push(input.stanceSummary.trim())
  }

  if (input.reasoningSnippet.trim().length > 0) {
    lines.push('', '## 附录：最近推理摘要')
    lines.push(input.reasoningSnippet.trim().slice(-2000))
  }

  lines.push('', '</session-handoff>')
  return lines.join('\n')
}

/**
 * Build a compact 4-field summary for injection into the message list after
 * compaction.  Deterministic (zero LLM cost) — all fields sourced from
 * extractTaskState / trajectory.
 *
 * Fields: Goals (current + remaining), Progress (completed), Active Files, Errors.
 */
export function buildCompactSummary(input: StructuredHandoffInput): string {
  const taskState = input.taskState
  const parts: string[] = []

  // Goals
  parts.push('## Goals')
  parts.push(`- Current: ${taskState.current || '(none)'}`)
  if (taskState.remaining.length > 0) {
    for (const item of taskState.remaining.slice(0, 5)) parts.push(`- [ ] ${item}`)
  }

  // Progress
  parts.push('', '## Progress')
  if (taskState.completed.length > 0) {
    for (const item of taskState.completed.slice(-5)) parts.push(`- [x] ${item}`)
  } else {
    parts.push('- (none)')
  }

  // Active files
  parts.push('', '## Active Files')
  if (input.filesSeen.length > 0) {
    for (const file of input.filesSeen.slice(0, 10)) parts.push(`- ${file}`)
  } else {
    parts.push('- (none)')
  }

  // Errors
  parts.push('', '## Errors')
  if (input.errors.length > 0) {
    for (const error of input.errors.slice(0, 5)) {
      parts.push(`- [Turn ${error.turn}] ${error.tool} ${error.target}: ${error.summary}`)
    }
  } else {
    parts.push('- (none)')
  }

  return `<compact-summary>\n${parts.join('\n')}\n</compact-summary>`
}

export interface CompactionControllerDeps {
  session: SessionContext
  promptEngine: PromptEngine
  contextWindow: number
  providerProfile?: ProviderProfile
  primaryClient?: StreamClient
  /**
   * When false, discretionary compaction (ratio tiers, 1M partial/full LLM
   * compact) is skipped entirely. Emergency paths — session split and the
   * 95% context ceiling — stay active regardless, because exceeding the
   * window is a hard API failure, not a tuning preference.
   * Worker sessions pass `compact.enabled: false` and previously relied on
   * this being silently ignored.
   */
  compactEnabled?: boolean
  pressureMonitor: PressureMonitor
  getTrajectoryEntries: () => TrajectoryEntry[]
  getStreamedText: () => string
  refreshLedger: () => void
  cacheAdvisor?: CacheAdvisor
  /** Collaboration-stance evidence, rendered into handoff so it survives compaction. */
  getStanceSummary?: () => string | null
  persistMemories?: (memories: Array<{ text: string; source: ExtractedMemory['source']; kind: ExtractedMemory['kind'] }>) => void | Promise<void>
  /** Current abort signal from the agent loop, so LLM compact can be cancelled. */
  getAbortSignal?: () => AbortSignal | undefined
  /**
   * C4: the live authoritative task contract. Re-injected into the appendix
   * region after every compaction so the goal / constraints / forbidden items
   * survive verbatim even when the LLM summary above drifts or drops them.
   */
  getActiveContract?: () => TaskContract | undefined
}

export interface MaybeCompactInput {
  loopTurn: number
  failures: CompactCircuitBreakerState
}

export interface MaybeCompactResult {
  failures: CompactCircuitBreakerState
  compacted: boolean
}

export class CompactionController {
  private _llmCompactInFlight = false
  private _prefixOverheadSet = false

  constructor(private deps: CompactionControllerDeps) {}

  /**
   * Compute the fixed token overhead from system prompt and tool definitions.
   * Called once per session. Without this baseline, estimatedTokens is
   * systematically 5K-8K tokens too low, causing compaction decisions to
   * trigger too late.
   */
  ensurePrefixOverhead(force = false): void {
    if (!force && this._prefixOverheadSet) return
    this._prefixOverheadSet = true

    // System prompt tokens
    const sysPrompt = this.deps.promptEngine.getSystemPrompt()
    const sysTokens = estimateOaiTokens([{ role: 'system', content: sysPrompt }])

    // Tool definition tokens: ~200 chars per tool, CHARS_PER_TOKEN=4 → ~50/tool
    // Conservative estimate based on typical tool schema size
    const toolCount = this.deps.promptEngine.getToolCount?.() ?? 12
    const toolTokens = toolCount * 50

    // Volatile block overhead (frozen hints, git-status, session-state)
    // — stripped for cache stability but still present in token count
    const volatileOverhead = 400

    const overhead = sysTokens + toolTokens + volatileOverhead
    this.deps.session.setPrefixOverhead(overhead)
  }

  async maybeCompact(input: MaybeCompactInput): Promise<MaybeCompactResult> {
    // Ensure prefix overhead is always set before any early return.
    // Without this, getEstimatedTokens() omits the system prompt + tool
    // definition cost, making GlanceBar show ctx 0% and ◧ 0/1.0M.
    this.ensurePrefixOverhead()

    if (this.deps.compactEnabled === false) {
      return { failures: input.failures, compacted: false }
    }

    const messages = this.deps.session.getMessages()

    // Prune removed (C4): pruneStaleToolResults was called here solely for debugLog
    // stats — it never mutated storage. The actual request-time pruning happens in
    // PromptEngine.buildOaiRequest via semanticPruneLayer1 + detectStaleness.

    this.ensurePrefixOverhead()
    const estimatedTokens = this.deps.session.getEstimatedTokens()
    const contextWindow = this.deps.contextWindow
    const ratio = contextWindow > 0 ? estimatedTokens / contextWindow : 0
    debugLog(`[compaction-check] contextWindow=${contextWindow} estimatedTokens=${estimatedTokens} ratio=${(ratio * 100).toFixed(1)}% turn=${this.deps.session.getTurnCount()}`)

    // Phase 2: On 1M+ context windows, skip micro compact but allow LLM
    // compact at 75% as a graceful degradation before the 86% session split.
    // This preserves key context via model-generated summary rather than the
    // abrupt "nuke everything" of trySessionSplit.
    //
    // Circuit breaker: consecutive LLM compact failures are tracked via
    // CompactCircuitBreakerState. After 3 consecutive failures, the breaker
    // opens and skips LLM compact for the next 3 turns, preventing repeated
    // 750K-860K token requests from being wasted on a failing pipeline.
    if (this.deps.contextWindow >= 1_000_000) {
      // Check circuit breaker before attempting any expensive compact
      const breakerOpen = input.failures.disabledUntilTurn !== undefined
        && this.deps.session.getTurnCount() < input.failures.disabledUntilTurn
      if (breakerOpen) {
        debugLog(`[llm-compact] circuit breaker open until turn ${input.failures.disabledUntilTurn} — skipping`)
        return { failures: input.failures, compacted: false }
      }

      // T8: Partial Compact at 60% — earlier, lighter, preserves recent context.
      if (ratio >= 0.60 && ratio < 0.75 && this.deps.primaryClient) {
        debugLog(`[partial-compact] 1M window at ${(ratio * 100).toFixed(0)}% — trying partial compact`)
        const partialResult = await this.tryPartialCompact(60)
        if (partialResult) {
          return { failures: recordCompactSuccess(input.failures), compacted: true }
        }
        debugLog('[partial-compact] partial compact failed — will wait for 75% full compact')
        return { failures: input.failures, compacted: false }
      }

      // Full LLM compact at 75% — fallback when partial was insufficient
      if (ratio >= 0.75 && this.deps.primaryClient) {
        // Try partial compact first (lighter)
        debugLog(`[llm-compact] 1M window at ${(ratio * 100).toFixed(0)}% — trying partial compact before full`)
        const partialResult = await this.tryPartialCompact(60)
        if (partialResult) {
          return { failures: recordCompactSuccess(input.failures), compacted: true }
        }

        debugLog(`[llm-compact] partial compact insufficient — triggering full LLM compact`)
        const summary = await this.llmCompact(undefined, this.deps.getAbortSignal?.())
        if (this.isAbortRequested()) {
          debugLog('[llm-compact] turn aborted after compact returned — skipping checkpoint replacement')
          return { failures: input.failures, compacted: false }
        }
        if (summary) {
          this.replaceWithCheckpoint({
            tier: 2,
            reason: `LLM compact at ${(ratio * 100).toFixed(0)}% context (1M window graceful degradation)`,
            summary,
            maxFallback: this.deps.contextWindow * 0.3,
            fallbackText: '<compact-summary>LLM compact failed to fit; session continues with cache anchors.</compact-summary>',
          })
          return { failures: recordCompactSuccess(input.failures), compacted: true }
        }
        debugLog(`[llm-compact] LLM compact failed (null summary)`)
        return {
          failures: recordCompactFailure(input.failures, this.deps.session.getTurnCount()),
          compacted: false,
        }
      }
      return { failures: input.failures, compacted: false }
    }

    const compactDecision = decideCompactTier({
      estimatedTokens,
      maxTokens: contextWindow,
      turn: this.deps.session.getTurnCount(),
      failures: input.failures,
      providerProfile: this.deps.providerProfile,
      recentHitRate: this.deps.cacheAdvisor?.getRecentHitRate() ?? null,
    })

    debugLog(`[compaction-decision] tier=${compactDecision.tier} shouldCompact=${compactDecision.shouldCompact} reason="${compactDecision.reason}"`)

    if (!compactDecision.shouldCompact) {
      return { failures: input.failures, compacted: false }
    }

    // Track 4: 显式 cache-miss 成本 vs 压缩收益权衡 — 传入压力上下文，
    // 热缓存只在低压力时挡住压缩，高压力时放行（1M 余量 > 前缀重建成本）。
    if (this.deps.cacheAdvisor?.shouldDelayCompact(compactDecision.tier, { estimatedTokens, contextWindow })) {
      return { failures: input.failures, compacted: false }
    }

    try {
      const { messages: compacted } = this.compactMessages(messages, estimatedTokens)

      // Tier 2+: inject a deterministic 4-field summary so the model retains
      // goals/progress/active-files/errors across compaction boundaries.
      // Only inject when compaction actually reduced message count (otherwise
      // the summary adds noise without reclaiming context).
      if (compactDecision.tier >= 2 && compacted.length < messages.length) {
        const taskState = extractTaskState(
          this.deps.getTrajectoryEntries(),
          this.deps.getStreamedText(),
        )
        const filePattern = /(?:\/[^\s\n"'`{}()[\]]+\.[a-z]{1,6})\b/g
        const filesSeen = new Set<string>()
        for (const m of compacted) {
          if (m.role !== 'tool') continue
          for (const match of m.content.matchAll(filePattern)) filesSeen.add(match[0])
        }
        const failures = this.deps.getTrajectoryEntries().filter(
          t => t.status === 'failed' || t.status === 'retried-failed',
        )
        const summaryText = buildCompactSummary({
          taskState: {
            current: taskState.current,
            completed: taskState.completed,
            remaining: taskState.remaining,
            decisions: taskState.decisions,
          },
          turnCount: this.deps.session.getTurnCount(),
          filesSeen: [...filesSeen],
          reasoningSnippet: '',
          errorCount: failures.length,
          errors: failures.slice(0, 5).map(f => ({
            turn: f.turn,
            tool: f.tool,
            target: f.target,
            errorClass: f.errorClass ?? 'unknown',
            summary: f.resultSummary || `${f.tool} in ${f.target} failed`,
          })),
          toolHistory: [],
        })
        compacted.push({ role: 'user', content: summaryText })

        // C4: re-inject the authoritative task anchor after the summary so the
        // objective / constraints / forbidden items survive verbatim.
        const anchorAppendix = this.buildTaskAnchorAppendix()
        if (anchorAppendix) {
          compacted.push({ role: 'user', content: anchorAppendix })
        }
      }

      this.deps.session.replaceMessages(compacted)
      this.deps.promptEngine.resetAppendixBaseline()
      this.deps.session.markCompacted(input.loopTurn)
      this.deps.pressureMonitor.recordCompaction(this.deps.session.getTurnCount())
      const afterTokens = this.deps.session.getEstimatedTokens()
      this.deps.session.recordCompactEvent({
        turn: this.deps.session.getTurnCount(),
        tier: 1,
        reason: `auto compact: ${compactDecision.reason}`,
        beforeTokens: estimatedTokens,
        afterTokens,
        createdAt: Date.now(),
      })

      // Cache-anchor drift is already captured by the recordCompaction above;
      // recording the same turn a second time inflates the thrashing counter.
      // The anchor-touch check remains for future cache-invalidation tracking.

      this.deps.refreshLedger()
      return { failures: recordCompactSuccess(input.failures), compacted: true }
    } catch {
      return {
        failures: recordCompactFailure(input.failures, this.deps.session.getTurnCount()),
        compacted: false,
      }
    }
  }

  async enforceContextCeiling(): Promise<void> {
    const ceiling = this.deps.contextWindow * 0.95
    if (this.deps.session.getEstimatedTokens() <= ceiling) return

    this.persistExtractedMemories(this.deps.getTrajectoryEntries())

    // Try LLM compact first (short timeout — emergency path, can't wait long)
    if (this.deps.primaryClient) {
      const summary = await this.llmCompact(30_000, this.deps.getAbortSignal?.())
      if (this.isAbortRequested()) {
        debugLog('[llm-compact] turn aborted after compact returned — skipping ceiling checkpoint replacement')
        return
      }
      if (summary) {
        this.replaceWithCheckpoint({
          tier: 4,
          reason: 'context ceiling exceeded; LLM compact checkpoint',
          summary,
          maxFallback: ceiling,
          fallbackText: '<checkpoint-resume>Context ceiling exceeded. Continue from preserved cache anchors.</checkpoint-resume>',
        })
        return
      }
    }

    // Fallback: structured extraction when LLM unavailable or fails
    const trajectory = this.deps.getTrajectoryEntries()
    const taskState = extractTaskState(trajectory, this.deps.getStreamedText())

    const stateLines = [
      `Current: ${taskState.current}`,
      ...taskState.completed.map(item => `Completed: ${item}`),
      ...taskState.remaining.map(item => `Remaining: ${item}`),
      ...taskState.decisions.map(item => `Decision: ${item}`),
    ]

    const recentTools = trajectory.slice(-10)
    for (const t of recentTools) {
      const status = t.status === 'failed' ? 'FAIL' : t.status === 'retried-success' ? 'ok*' : 'ok'
      stateLines.push(`Tool: ${t.tool} ${t.target} [${status}]`)
    }

    const failures = trajectory.filter(t => t.status === 'failed' || t.status === 'retried-failed')
    for (const f of failures.slice(0, 5)) {
      stateLines.push(`Failed: ${f.tool} in ${f.target} (${f.errorClass ?? 'unknown'})`)
    }

    const resumeContent = `<checkpoint-resume>\n${stateLines.join('\n')}\n</checkpoint-resume>`

    this.replaceWithCheckpoint({
      tier: 4,
      reason: 'context ceiling exceeded; checkpoint-resume required',
      summary: resumeContent,
      maxFallback: ceiling,
      fallbackText: '<checkpoint-resume>Context ceiling exceeded. Continue from preserved cache anchors and ask for missing details if needed.</checkpoint-resume>',
    })
  }

  /**
   * Phase 2.3: Proactive session split at 86% context threshold.
   * Tries LLM compact first; falls back to structured handoff extraction.
   */
  async trySessionSplit(): Promise<boolean> {
    if (this.deps.contextWindow < 500_000) return false

    const ratio = this.deps.session.getEstimatedTokens() / this.deps.contextWindow
    if (ratio < 0.86) return false

    const trajectory = this.deps.getTrajectoryEntries()
    this.persistExtractedMemories(trajectory)

    // Try LLM compact first for higher-fidelity summary
    if (this.deps.primaryClient) {
      const summary = await this.llmCompact(undefined, this.deps.getAbortSignal?.())
      if (this.isAbortRequested()) {
        debugLog('[llm-compact] turn aborted after compact returned — skipping session-split checkpoint replacement')
        return false
      }
      if (summary) {
        this.replaceWithCheckpoint({
          tier: 3,
          reason: `session split at ${(ratio * 100).toFixed(0)}% context (LLM compact)`,
          summary,
          maxFallback: this.deps.contextWindow * 0.3,
          fallbackText: `<session-handoff>Session split at ${(ratio * 100).toFixed(0)}% context.</session-handoff>`,
        })
        debugLog(`[session-split] LLM compact ratio=${ratio.toFixed(2)} tokens=${this.deps.session.getEstimatedTokens()}`)
        return true
      }
    }

    // Fallback: structured extraction
    const messages = this.deps.session.getMessages()
    const taskState = extractTaskState(trajectory, this.deps.getStreamedText())

    const MAX_REASONING_CHARS = 2000
    const reasoningParts: string[] = []
    for (let i = messages.length - 1; i >= 0 && reasoningParts.join('\n').length < MAX_REASONING_CHARS; i--) {
      const m = messages[i]!
      if (m.role === 'assistant' && m.content && m.content.length > 0) {
        reasoningParts.unshift(m.content)
      }
    }

    const filePattern = /(?:\/[^\s\n"'`{}()[\]]+\.[a-z]{1,6})\b/g
    const filesSeen = new Set<string>()
    for (const m of messages) {
      if (m.role !== 'tool') continue
      for (const match of m.content.matchAll(filePattern)) {
        filesSeen.add(match[0])
      }
    }

    const recentTools = trajectory.slice(-10)
    const failures = trajectory.filter(t => t.status === 'failed' || t.status === 'retried-failed')
    const handoffContent = buildStructuredHandoff({
      taskState: {
        current: taskState.current,
        completed: taskState.completed,
        remaining: taskState.remaining,
        decisions: taskState.decisions,
      },
      turnCount: this.deps.session.getTurnCount(),
      filesSeen: [...filesSeen],
      reasoningSnippet: reasoningParts.join('\n\n---\n\n').slice(-MAX_REASONING_CHARS),
      errorCount: failures.length,
      errors: failures.slice(0, 5).map(f => ({
        turn: f.turn,
        tool: f.tool,
        target: f.target,
        errorClass: f.errorClass ?? 'unknown',
        summary: f.resultSummary || `${f.tool} in ${f.target} failed`,
      })),
      toolHistory: recentTools.map(t => ({
        tool: t.tool,
        target: t.target,
        status: t.status,
      })),
      stanceSummary: this.deps.getStanceSummary?.(),
    })

    this.replaceWithCheckpoint({
      tier: 3,
      reason: `session split at ${(ratio * 100).toFixed(0)}% context`,
      summary: handoffContent,
      maxFallback: this.deps.contextWindow * 0.3,
      fallbackText: `<session-handoff>Session split at ${(ratio * 100).toFixed(0)}% context. ${taskState.current}</session-handoff>`,
    })

    debugLog(
      `[session-split] ratio=${ratio.toFixed(2)} files=${filesSeen.size} ` +
      `reasoning_chars=${reasoningParts.join('').length} ` +
      `tokens=${this.deps.session.getEstimatedTokens()}`
    )

    return true
  }

  refreshCacheDiagnostic(loopTurn: number): string | null {
    const history = this.deps.session.getCacheHistory()
    // No provider cache data this turn (both counters 0) → no-data, not a 0%
    // hit. getLatestTurnHitRate reports 0 here (inputTokens denominator), which
    // would otherwise surface a spurious "First turn" diagnostic. Nothing to
    // diagnose when the provider reported no cache numbers at all.
    const latest = history[history.length - 1]
    if (latest && latest.cacheRead === 0 && latest.cacheCreation === 0) return null
    const hitRate = this.deps.session.getLatestTurnHitRate()
    if (hitRate !== null && hitRate < 0.8) {
      const diagnostic = diagnoseCacheMiss(
        history,
        this.deps.session.getTurnCount(),
        this.deps.promptEngine.checkDrift(),
        this.deps.session.wasCompactedAt(loopTurn),
      )
      return diagnostic?.message ?? null
    }
    return null
  }

  private compactMessages(
    messages: OaiMessage[],
    tokenCount: number,
  ): { messages: OaiMessage[] } {
    return microCompactOai(messages, this.deps.contextWindow, tokenCount)
  }

  private isAbortRequested(): boolean {
    return this.deps.getAbortSignal?.()?.aborted === true
  }

  private persistExtractedMemories(trajectory: TrajectoryEntry[]): void {
    if (!this.deps.persistMemories) return

    try {
      const memories = extractSessionMemories(this.deps.session.getMessages(), {
        recentToolTargets: trajectory.map(t => t.target),
      })
      if (memories.length === 0) return
      const payload = memories.map(memory => ({
        text: memory.text,
        source: memory.source,
        kind: memory.kind,
      }))
      void Promise.resolve(this.deps.persistMemories(payload)).catch(() => {})
    } catch {
      // Session memory extraction is opportunistic; compaction must continue.
    }
  }

  /**
   * C4: render the authoritative task anchor for appendix re-injection.
   * Fuses the verbatim contract (objective / constraints / success) with live
   * progress (completed / remaining) from the trajectory-derived task state.
   * Returns null when there is no actionable contract.
   */
  private buildTaskAnchorAppendix(): string | null {
    const contract = this.deps.getActiveContract?.()
    if (!contract) return null
    const taskState = extractTaskState(
      this.deps.getTrajectoryEntries(),
      this.deps.getStreamedText(),
    )
    const anchor = renderTaskAnchor(contract, {
      completed: taskState.completed,
      remaining: taskState.remaining,
    })
    return anchor.length > 0 ? anchor : null
  }

  /**
   * Replace message history with cache anchors + checkpoint summary.
   * Called by both trySessionSplit (86% threshold, richer handoff) and
   * enforceContextCeiling (95% threshold, emergency fallback).
   */
  private replaceWithCheckpoint(params: {
    tier: CompactTier
    reason: string
    summary: string
    maxFallback: number
    fallbackText: string
  }): void {
    const messages = this.deps.session.getMessages()
    const anchorMessages = messages.slice(0, CACHE_ANCHOR_MESSAGES)
    let candidate: OaiMessage[] = [...anchorMessages, { role: 'user', content: params.summary }]

    if (estimateOaiTokens(candidate) > params.maxFallback) {
      candidate = [...anchorMessages, { role: 'user', content: params.fallbackText }]
    }

    // C4: append the authoritative task anchor at the tail (appendix region —
    // never the frozen prefix, so prefix-cache stays intact). The anchor is the
    // ground truth the model defers to if the summary above drifted.
    const anchorAppendix = this.buildTaskAnchorAppendix()
    if (anchorAppendix) {
      candidate.push({ role: 'user', content: anchorAppendix })
    }

    const beforeTokens = estimateOaiTokens(messages)
    this.deps.session.replaceMessages(candidate)
    this.deps.promptEngine.resetAppendixBaseline()
    this.deps.session.recordCompactEvent({
      turn: this.deps.session.getTurnCount(),
      tier: params.tier,
      reason: params.reason,
      beforeTokens,
      afterTokens: this.deps.session.getEstimatedTokens(),
      createdAt: Date.now(),
    })
    this.deps.refreshLedger()
  }

  /**
   * T8: Partial Compact — summarize only old messages, preserve recent ones.
   * Splits messages into: anchor (first 2) + old zone + recent zone (last N).
   * Only the old zone is summarized via LLM; recent messages are kept intact.
   * Returns true if successful, false if LLM summary failed.
   */
  async tryPartialCompact(recentToPreserve = 60): Promise<boolean> {
    if (!this.deps.primaryClient) return false
    if (this._llmCompactInFlight) return false

    const messages = this.deps.session.getMessages()
    const anchorCount = CACHE_ANCHOR_MESSAGES
    if (messages.length <= anchorCount + recentToPreserve + 4) {
      debugLog(`[partial-compact] not enough messages to split (${messages.length} total, need > ${anchorCount + recentToPreserve + 4})`)
      return false
    }

    const anchor = messages.slice(0, anchorCount)
    const rawSplitPoint = messages.length - recentToPreserve
    const splitPoint = findSafeSplitPoint(messages, rawSplitPoint, anchorCount)
    // If the safe split point leaves too few oldZone messages, skip compaction
    if (splitPoint <= anchorCount + 4) {
      debugLog(`[partial-compact] safe split point ${splitPoint} too close to anchor ${anchorCount} — skipping`)
      return false
    }
    const oldZone = messages.slice(anchorCount, splitPoint)
    const recentZone = messages.slice(splitPoint)

    debugLog(`[partial-compact] anchor=${anchor.length} old=${oldZone.length} recent=${recentZone.length}`)

    const userIntentChain = extractUserIntentChain(oldZone)
    const partialBudget = summaryOutputBudgetChars(this.deps.contextWindow).partial
    const summaryPrompt: OaiMessage = {
      role: 'user',
      content: [
        '请总结以下对话片段的关键信息（这是对话的较早部分，最近的消息会被完整保留）。',
        '',
        '## 用户意图链（按时间序）',
        ...userIntentChain.map((m, i) => `${i + 1}. ${m}`),
        '',
        '## 保留',
        '1. 每条用户消息的核心意图',
        '2. 关键技术决策和原因',
        '3. 涉及的文件路径和变更摘要',
        '4. 错误和修复方法',
        '',
        '## 丢弃',
        '- 工具输出详情（只保留结论）',
        '- 探索性搜索的中间过程',
        '',
        `控制在 ${partialBudget} 字以内。只输出总结，不要调用工具。`,
      ].join('\n'),
    }

    this._llmCompactInFlight = true
    try {
      const compactMessages: OaiMessage[] = [...anchor, ...oldZone, summaryPrompt]
      const request = this.deps.promptEngine.buildOaiRequest(
        compactMessages,
        undefined,
        this.deps.contextWindow,
      )
      request.tools = undefined

      const chunks: string[] = []
      let errored = false
      const signal = this.deps.getAbortSignal?.()
      const timeoutSignal = AbortSignal.timeout(60_000)
      const combinedSignal = signal
        ? AbortSignal.any([signal, timeoutSignal])
        : timeoutSignal

      try {
        await this.deps.primaryClient.stream(request, {
          onTextDelta: (text) => { chunks.push(text) },
          onThinkingDelta: () => {},
          onContentBlock: () => {},
          onStopReason: () => {},
          onError: () => { errored = true },
        }, combinedSignal)
      } catch {
        return false
      }

      if (errored || chunks.length === 0) return false
      const summary = chunks.join('').trim()
      if (summary.length === 0) return false

      const summaryMessage: OaiMessage = {
        role: 'assistant',
        content: `<partial-compact-summary turn="${this.deps.session.getTurnCount()}">\n${summary}\n</partial-compact-summary>`,
      }

      const newMessages = [...anchor, summaryMessage, ...recentZone]
      this.deps.session.replaceMessages(newMessages)
      this.deps.promptEngine.resetAppendixBaseline()
      this.deps.refreshLedger()

      debugLog(`[partial-compact] success: ${messages.length} → ${newMessages.length} messages (removed ${oldZone.length} old, kept ${recentZone.length} recent)`)
      return true
    } finally {
      this._llmCompactInFlight = false
    }
  }

  /**
   * Forked Agent LLM compaction: sends a compact-summary request through the
   * primary model's StreamClient, reusing cache anchors (first 2 messages)
   * for ~90% prefix cache hit rate.
   *
   * @returns compact summary string, or null if primaryClient unavailable
   *          or session has insufficient messages.
   */
  async llmCompact(timeoutMs = 60_000, userSignal?: AbortSignal): Promise<string | null> {
    if (!this.deps.primaryClient) return null
    if (this._llmCompactInFlight) return null
    this._llmCompactInFlight = true

    try {
      const messages = this.deps.session.getMessages()
      if (messages.length < CACHE_ANCHOR_MESSAGES + 2) return null

      const userIntentChain = extractUserIntentChain(messages)
      const compactMessages: OaiMessage[] = [
        ...messages,
        {
          role: 'user' as const,
          content: [
            '请总结上述对话的关键信息，用于上下文压缩。',
            '',
            '## 必须完整保留的用户意图链',
            '以下是用户所有消息（按时间序），**必须逐条保留核心意图，不得合并或遗漏**：',
            ...userIntentChain.map((m, i) => `${i + 1}. ${m}`),
            '',
            '## 保留以下内容',
            '1. 用户的核心需求和意图演变（如果用户纠正了 agent 的理解，以用户的纠正为准）',
            '2. 所有关键技术决策及其原因',
            '3. 涉及的文件路径及变更摘要',
            '4. 遇到的错误及修复方法',
            '5. 当前工作状态和进度',
            '6. 明确的待办事项和下一步',
            '',
            '## 丢弃以下内容',
            '- 工具输出的详细内容（只保留结论）',
            '- 探索性搜索的中间过程',
            '- 重复的状态汇报',
            '',
            `只输出总结内容，不要调用工具。格式用 markdown，控制在 ${summaryOutputBudgetChars(this.deps.contextWindow).full} 字以内。`,
          ].join('\n'),
        },
      ]

      const request = this.deps.promptEngine.buildOaiRequest(
        compactMessages,
        undefined,
        this.deps.contextWindow,
      )
      request.tools = undefined

      const chunks: string[] = []
      let errored = false
      const timeoutSignal = AbortSignal.timeout(timeoutMs)
      const signal = userSignal
        ? AbortSignal.any([userSignal, timeoutSignal])
        : timeoutSignal
      try {
        await this.deps.primaryClient.stream(request, {
          onTextDelta: (text) => { chunks.push(text) },
          onThinkingDelta: () => {},
          onContentBlock: () => {},
          onStopReason: () => {},
          onError: () => { errored = true },
        }, signal)
      } catch {
        return null
      }

      if (errored || chunks.length === 0) return null

      const summary = chunks.join('').trim()
      if (summary.length === 0) return null

      return `<compact-summary turn="${this.deps.session.getTurnCount()}" tokens="${this.deps.session.getEstimatedTokens()}">\n${summary}\n</compact-summary>`
    } finally {
      this._llmCompactInFlight = false
    }
  }

  /**
   * Build a structured handoff text from current session state.
   * Called by AgentLoop.runPostSession to persist for the next session.
   */
  buildSessionHandoff(): string {
    const messages = this.deps.session.getMessages()
    const trajectory = this.deps.getTrajectoryEntries()
    const streamedText = this.deps.getStreamedText()
    const taskState = extractTaskState(trajectory, streamedText)
    const turnCount = this.deps.session.getTurnCount()

    // Extract files seen from user + assistant messages
    const filesSeen = new Set<string>()
    for (const m of messages) {
      if (m.role === 'user' && typeof m.content === 'string') {
        const matches = m.content.matchAll(/(?:^|\s)([a-zA-Z0-9_./-]+\.(?:ts|tsx|js|jsx|py|md|json|yaml|yml))/g)
        for (const match of matches) {
          if (match[1]) filesSeen.add(match[1])
        }
      }
    }

    // Extract errors from trajectory
    const errors: StructuredHandoffInput['errors'] = trajectory
      .filter(t => t.status === 'failed' || t.status === 'retried-failed')
      .map(t => ({
        turn: t.turn,
        tool: t.tool,
        target: t.target,
        errorClass: t.errorClass ?? 'unknown',
        summary: t.resultSummary.slice(0, 120),
      }))

    // Build tool history
    const toolHistory: StructuredHandoffInput['toolHistory'] = trajectory.map(t => ({
      tool: t.tool,
      target: t.target,
      status: t.status,
    }))

    const reasoningParts: string[] = []
    for (const m of messages) {
      if (m.role === 'assistant' && typeof m.content === 'string' && m.content.trim()) {
        reasoningParts.push(m.content)
      }
    }
    const reasoningSnippet = reasoningParts.slice(-3).join('\n')

    return buildStructuredHandoff({
      taskState,
      turnCount,
      filesSeen: [...filesSeen].sort(),
      reasoningSnippet,
      errorCount: errors.length,
      errors,
      toolHistory,
      stanceSummary: this.deps.getStanceSummary?.() ?? null,
    })
  }
}
