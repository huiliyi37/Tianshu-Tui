import type { StreamClient } from '../api/stream-client.js'
import type { OaiMessage } from '../api/oai-types.js'
import { CACHE_ANCHOR_MESSAGES } from '../compact/constants.js'
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
import type { TrajectoryEntry } from './trajectory.js'
import type { CacheAdvisor } from '../cache/advisor.js'
import { extractSessionMemories, type ExtractedMemory } from './session-memory-extract.js'

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
  private _ensurePrefixOverhead(): void {
    if (this._prefixOverheadSet) return
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
    const messages = this.deps.session.getMessages()

    // Prune removed (C4): pruneStaleToolResults was called here solely for debugLog
    // stats — it never mutated storage. The actual request-time pruning happens in
    // PromptEngine.buildOaiRequest via semanticPruneLayer1 + detectStaleness.

    this._ensurePrefixOverhead()
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
      if (ratio >= 0.75 && this.deps.primaryClient) {
        // Check circuit breaker before attempting expensive LLM compact
        const breakerOpen = input.failures.disabledUntilTurn !== undefined
          && this.deps.session.getTurnCount() < input.failures.disabledUntilTurn
        if (breakerOpen) {
          debugLog(`[llm-compact] circuit breaker open until turn ${input.failures.disabledUntilTurn} — skipping`)
          return { failures: input.failures, compacted: false }
        }
        debugLog(`[llm-compact] 1M window at ${(ratio * 100).toFixed(0)}% — triggering LLM compact`)
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
        // LLM compact returned null — track failure for circuit breaker
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

    if (this.deps.cacheAdvisor?.shouldDelayCompact(compactDecision.tier)) {
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
      }

      this.deps.session.replaceMessages(compacted)
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
    const hitRate = this.deps.session.getLatestTurnHitRate()
    if (hitRate !== null && hitRate < 0.8) {
      const diagnostic = diagnoseCacheMiss(
        this.deps.session.getCacheHistory(),
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

    const beforeTokens = estimateOaiTokens(messages)
    this.deps.session.replaceMessages(candidate)
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

      const compactMessages: OaiMessage[] = [
        ...messages,
        {
          role: 'user' as const,
          content: [
            '请总结上述对话的关键信息，用于上下文压缩。',
            '保留以下内容：',
            '1. 用户的核心需求和意图',
            '2. 所有关键技术决策及其原因',
            '3. 涉及的文件路径及变更摘要',
            '4. 遇到的错误及修复方法',
            '5. 当前工作状态和进度',
            '6. 明确的待办事项和下一步',
            '',
            '只输出总结内容，不要调用工具。格式用 markdown，控制在 3000 字以内。',
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
}
