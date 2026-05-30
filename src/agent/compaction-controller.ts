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
  constructor(private deps: CompactionControllerDeps) {}

  async maybeCompact(input: MaybeCompactInput): Promise<MaybeCompactResult> {
    const messages = this.deps.session.getMessages()

    // Prune removed (C4): pruneStaleToolResults was called here solely for debugLog
    // stats — it never mutated storage. The actual request-time pruning happens in
    // PromptEngine.buildOaiRequest via semanticPruneLayer1 + detectStaleness.

    // Phase 2: On 1M+ context windows, skip micro compact but allow LLM
    // compact at 75% as a graceful degradation before the 86% session split.
    // This preserves key context via model-generated summary rather than the
    // abrupt "nuke everything" of trySessionSplit.
    if (this.deps.contextWindow >= 1_000_000) {
      const ratio = this.deps.session.getEstimatedTokens() / this.deps.contextWindow
      if (ratio >= 0.75 && this.deps.primaryClient) {
        debugLog(`[llm-compact] 1M window at ${(ratio * 100).toFixed(0)}% — triggering LLM compact`)
        const summary = await this.llmCompact(undefined, this.deps.getAbortSignal?.())
        if (summary) {
          this.replaceWithCheckpoint({
            tier: 2,
            reason: `LLM compact at ${(ratio * 100).toFixed(0)}% context (1M window graceful degradation)`,
            summary,
            maxFallback: this.deps.contextWindow * 0.3,
            fallbackText: '<compact-summary>LLM compact failed to fit; session continues with cache anchors.</compact-summary>',
          })
          return { failures: input.failures, compacted: true }
        }
      }
      return { failures: input.failures, compacted: false }
    }

    const estimatedTokens = this.deps.session.getEstimatedTokens()
    const compactDecision = decideCompactTier({
      estimatedTokens,
      maxTokens: this.deps.contextWindow,
      turn: this.deps.session.getTurnCount(),
      failures: input.failures,
      providerProfile: this.deps.providerProfile,
      recentHitRate: this.deps.cacheAdvisor?.getRecentHitRate() ?? null,
    })

    if (!compactDecision.shouldCompact) {
      return { failures: input.failures, compacted: false }
    }

    if (this.deps.cacheAdvisor?.shouldDelayCompact(compactDecision.tier)) {
      return { failures: input.failures, compacted: false }
    }

    try {
      const { messages: compacted } = this.compactMessages(messages, estimatedTokens)
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

      if (messages.length >= CACHE_ANCHOR_MESSAGES && compacted.length >= CACHE_ANCHOR_MESSAGES) {
        const oldAnchor = messages[CACHE_ANCHOR_MESSAGES - 1]!
        const newAnchor = compacted[CACHE_ANCHOR_MESSAGES - 1]!
        const anchorTouched = typeof oldAnchor.content === 'string'
          ? oldAnchor.content !== (typeof newAnchor.content === 'string' ? newAnchor.content : null)
          : true
        if (anchorTouched) {
          this.deps.pressureMonitor.recordCompaction(this.deps.session.getTurnCount())
        }
      }

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
