import type { StreamClient } from '../api/stream-client.js'
import type { OaiMessage } from '../api/oai-types.js'
import { CACHE_ANCHOR_MESSAGES } from '../compact/constants.js'
import { microCompactOai, estimateOaiTokens } from '../compact/micro.js'
import { decideCompactTier, recordCompactFailure, recordCompactSuccess } from '../context/compact-policy.js'
import type { CompactCircuitBreakerState } from '../context/types.js'
import type { ProviderProfile } from '../api/provider-profile.js'
import { diagnoseCacheMiss } from '../prompt/cache-diagnostic.js'
import type { PromptEngine } from '../prompt/engine.js'
import type { PressureMonitor } from '../context/pressure-monitor.js'
import type { SessionContext } from './context.js'
import { extractTaskState } from './task-state.js'
import type { TrajectoryEntry } from './trajectory.js'

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
    const estimatedTokens = this.deps.session.getEstimatedTokens()
    const compactDecision = decideCompactTier({
      estimatedTokens,
      maxTokens: this.deps.contextWindow,
      turn: this.deps.session.getTurnCount(),
      failures: input.failures,
      providerProfile: this.deps.providerProfile,
    })

    if (!compactDecision.shouldCompact) {
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
