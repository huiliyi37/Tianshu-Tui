import type { StreamClient } from '../api/stream-client.js'
import type { OaiMessage } from '../api/oai-types.js'
import { CACHE_ANCHOR_MESSAGES } from '../compact/constants.js'
import { microCompactOai, estimateOaiTokens } from '../compact/micro.js'
import { pruneStaleToolResults } from '../compact/prune.js'
import { decideCompactTier, recordCompactFailure, recordCompactSuccess } from '../context/compact-policy.js'
import type { CompactCircuitBreakerState } from '../context/types.js'
import type { ProviderProfile } from '../api/provider-profile.js'
import { diagnoseCacheMiss } from '../prompt/cache-diagnostic.js'
import type { PromptEngine } from '../prompt/engine.js'
import type { PressureMonitor } from '../context/pressure-monitor.js'
import type { SessionContext } from './context.js'
import { extractTaskState } from './task-state.js'
import type { TrajectoryEntry } from './trajectory.js'
import type { CacheAdvisor } from '../cache/advisor.js'

export interface CompactionControllerDeps {
  session: SessionContext
  promptEngine: PromptEngine
  contextWindow: number
  providerProfile?: ProviderProfile
  compactClient?: StreamClient
  compactModel?: string
  pressureMonitor: PressureMonitor
  getTrajectoryEntries: () => TrajectoryEntry[]
  getStreamedText: () => string
  refreshLedger: () => void
  cacheAdvisor?: CacheAdvisor
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
  constructor(private deps: CompactionControllerDeps) {}

  async maybeCompact(input: MaybeCompactInput): Promise<MaybeCompactResult> {
    const messages = this.deps.session.getMessages()

    // Lightweight prune: clear stale tool results before checking compact thresholds.
    // Free (no LLM call) and stabilizes the prefix for cache hits.
    // Pass contextWindow so prune scales its protectRecent/minChars to the
    // window — prevents the 1M-window-but-still-pruning-after-4-turns regression.
    const beforePruneTokens = this.deps.session.getEstimatedTokens()
    const pruneResult = pruneStaleToolResults(messages, { contextWindow: this.deps.contextWindow })
    if (pruneResult.prunedCount > 0) {
      // Prune is now a request-time mask (applied in PromptEngine.buildOaiRequest).
      // We compute prune stats here for logging but do NOT mutate storage via
      // replaceMessages. Immutable history = stable byte prefix = higher cache hit.
      const afterPruneTokens = this.deps.session.getEstimatedTokens()
      // eslint-disable-next-line no-console
      console.warn(`[prune] (request-time mask) would-prune=${pruneResult.prunedCount} freedChars=${pruneResult.freedChars} ctxWindow=${this.deps.contextWindow} tokens=${beforePruneTokens}->${afterPruneTokens}`)
    }

    // Phase 2: On 1M+ context windows, skip micro compact entirely.
    // The 1M window has enough headroom for typical coding sessions
    // (30-100 turns). Disabling compaction preserves the exact byte
    // prefix for DeepSeek's persistent cache, eliminating the 3-4%
    // compaction-induced miss rate. enforceContextCeiling (95%) remains
    // as the emergency last resort.
    if (this.deps.contextWindow >= 1_000_000) {
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

  enforceContextCeiling(): void {
    const ceiling = this.deps.contextWindow * 0.95
    if (this.deps.session.getEstimatedTokens() <= ceiling) return

    const messages = this.deps.session.getMessages()
    const taskState = extractTaskState(this.deps.getTrajectoryEntries(), this.deps.getStreamedText())
    const stateLines = [
      `Current: ${taskState.current}`,
      ...taskState.completed.map(item => `Completed: ${item}`),
      ...taskState.remaining.map(item => `Remaining: ${item}`),
      ...taskState.decisions.map(item => `Decision: ${item}`),
    ]
    const anchorMessages = messages.slice(0, CACHE_ANCHOR_MESSAGES)
    let resumeContent = `<checkpoint-resume>\n${stateLines.join('\n')}\n</checkpoint-resume>`
    let candidate: OaiMessage[] = [...anchorMessages, { role: 'user', content: resumeContent }]

    if (estimateOaiTokens(candidate) > ceiling) {
      resumeContent = '<checkpoint-resume>Context ceiling exceeded. Continue from preserved cache anchors and ask for missing details if needed.</checkpoint-resume>'
      candidate = [...anchorMessages, { role: 'user', content: resumeContent }]
    }

    this.deps.session.replaceMessages(candidate)
    this.deps.session.recordCompactEvent({
      turn: this.deps.session.getTurnCount(),
      tier: 4,
      reason: 'context ceiling exceeded; checkpoint-resume required',
      beforeTokens: estimateOaiTokens(messages),
      afterTokens: this.deps.session.getEstimatedTokens(),
      createdAt: Date.now(),
    })
    this.deps.refreshLedger()
  }

  /**
   * Phase 2.3: Proactive session split at 86% context threshold.
   *
   * Unlike compaction (which mutates message history and breaks the prefix
   * cache), session split replaces ALL messages with just the cache anchors +
   * a rich handoff summary. The system prompt + tools + first 2 messages
   * remain byte-identical, so DeepSeek's disk cache hits immediately on
   * the next API call.
   *
   * enforceContextCeiling (95%) remains as the emergency last resort, but
   * in a healthy 1M window session, trySessionSplit should fire first.
   *
   * @returns true if a split occurred, false if below threshold or ineligible.
   */
  trySessionSplit(): boolean {
    // Only for large windows (500K+) where we have enough headroom for
    // the split to meaningfully reduce context. Small windows need
    // compaction, not split.
    if (this.deps.contextWindow < 500_000) return false

    const ratio = this.deps.session.getEstimatedTokens() / this.deps.contextWindow
    if (ratio < 0.86) return false

    const messages = this.deps.session.getMessages()
    const taskState = extractTaskState(this.deps.getTrajectoryEntries(), this.deps.getStreamedText())

    // Extract up to 2KB of the most recent assistant reasoning
    const MAX_REASONING_CHARS = 2000
    const reasoningParts: string[] = []
    for (let i = messages.length - 1; i >= 0 && reasoningParts.join('\n').length < MAX_REASONING_CHARS; i--) {
      const m = messages[i]!
      if (m.role === 'assistant' && m.content && m.content.length > 0) {
        reasoningParts.unshift(m.content)
      }
    }

    // Extract file paths from tool result content
    const filePattern = /(?:\/[^\s\n"'`{}()[\]]+\.[a-z]{1,6})\b/g
    const filesSeen = new Set<string>()
    for (const m of messages) {
      if (m.role !== 'tool') continue
      for (const match of m.content.matchAll(filePattern)) {
        filesSeen.add(match[0])
      }
    }

    const handoffLines: string[] = [
      `Session split at ${(ratio * 100).toFixed(0)}% context (turn ${this.deps.session.getTurnCount()})`,
      `Current: ${taskState.current}`,
    ]
    for (const item of taskState.completed.slice(-5)) {
      handoffLines.push(`Completed: ${item}`)
    }
    for (const item of taskState.remaining.slice(0, 3)) {
      handoffLines.push(`Remaining: ${item}`)
    }
    for (const item of taskState.decisions.slice(-3)) {
      handoffLines.push(`Decision: ${item}`)
    }
    if (filesSeen.size > 0) {
      const files = [...filesSeen].slice(0, 10)
      handoffLines.push(`Files: ${files.join(', ')}`)
    }

    let handoffContent = `<session-handoff>\n${handoffLines.join('\n')}\n</session-handoff>`
    if (reasoningParts.length > 0) {
      const reasoning = reasoningParts.join('\n\n---\n\n')
      handoffContent += `\n\n## Recent reasoning:\n${reasoning.slice(-MAX_REASONING_CHARS)}`
    }

    const anchorMessages = messages.slice(0, CACHE_ANCHOR_MESSAGES)
    let candidate: OaiMessage[] = [
      ...anchorMessages,
      { role: 'user', content: handoffContent },
    ]

    // Safety: if the handoff itself is too large, use a minimal fallback
    if (estimateOaiTokens(candidate) > this.deps.contextWindow * 0.3) {
      const fallback = `<session-handoff>Session split at ${(ratio * 100).toFixed(0)}% context. ${taskState.current}</session-handoff>`
      candidate = [...anchorMessages, { role: 'user', content: fallback }]
    }

    const beforeTokens = this.deps.session.getEstimatedTokens()
    this.deps.session.replaceMessages(candidate)
    this.deps.session.recordCompactEvent({
      turn: this.deps.session.getTurnCount(),
      tier: 3,
      reason: `session split at ${(ratio * 100).toFixed(0)}% context`,
      beforeTokens,
      afterTokens: this.deps.session.getEstimatedTokens(),
      createdAt: Date.now(),
    })
    this.deps.refreshLedger()

    // eslint-disable-next-line no-console
    console.warn(
      `[session-split] ratio=${ratio.toFixed(2)} files=${filesSeen.size} ` +
      `reasoning_chars=${reasoningParts.join('').length} ` +
      `tokens=${beforeTokens}->${this.deps.session.getEstimatedTokens()}`
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
}
