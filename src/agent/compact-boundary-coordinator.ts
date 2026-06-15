import { estimateOaiTokens } from '../compact/micro.js'
import { compactStaleRoundsOai } from '../compact/stale-round.js'
import { microCompactOai } from '../compact/micro.js'
import { staleRoundThresholds } from '../compact/constants.js'
import type { CompactCircuitBreakerState } from '../context/types.js'

export interface CompactBoundaryDeps {
  // Field accessors
  getCompactFailures: () => CompactCircuitBreakerState
  setCompactFailures: (f: CompactCircuitBreakerState) => void
  getLastCompactTurn: () => number | null
  setLastCompactTurn: (t: number | null) => void
  getPendingStaleCompact: () => boolean
  setPendingStaleCompact: (v: boolean) => void
  getPendingHeapCompact: () => boolean
  setPendingHeapCompact: (v: boolean) => void
  getPrevPhaseHint: () => string | undefined
  setPrevPhaseHint: (h: string | undefined) => void

  // External deps
  getAbortSignal: () => AbortSignal | undefined
  getContextWindow: () => number
  getPhaseHint: () => string | undefined
  getEstimatedTokens: () => number
  getMessages: () => import('../api/oai-types.js').OaiMessage[]
  replaceMessages: (msgs: import('../api/oai-types.js').OaiMessage[]) => void
  dietMessages: (msgs: import('../api/oai-types.js').OaiMessage[]) => { removedCount: number; messages: import('../api/oai-types.js').OaiMessage[] }
  trySessionSplit: () => Promise<boolean>
  maybeCompact: (opts: { loopTurn: number; failures: CompactCircuitBreakerState }) => Promise<{ compacted: boolean; failures: CompactCircuitBreakerState }>
  tryPartialCompact: (targetTurnAge: number) => Promise<boolean>
  shouldDelayCompact: (turnThreshold: number, ctx?: { estimatedTokens?: number; contextWindow?: number }) => boolean
  getStalePreviewChars: () => number
  injectImmuneSignal: (signal: { kind: string; severity: number; turn: number; source: string }) => void
}

export interface RunCompactionResult {
  compacted: boolean
  shouldAbort: boolean
  userMessageConsumed: boolean
}

export class CompactBoundaryCoordinator {
  constructor(private deps: CompactBoundaryDeps) {}

  /** Phase 2.3: Proactive session split at 86% context — MUST run BEFORE addUserMessage. */
  async preUserMessageSplit(): Promise<void> {
    await this.deps.trySessionSplit()
  }

  async runCompaction(turn: number, snap: { memory: { heapUsedBytes: number; memoryLimitBytes: number } } | null): Promise<RunCompactionResult> {
    let userMessageConsumed = false

    // Phase 2.3: Proactive session split at 86% context.
    if (await this.deps.trySessionSplit()) {
      userMessageConsumed = true
    }
    if (this.deps.getAbortSignal()?.aborted) {
      return { compacted: false, shouldAbort: true, userMessageConsumed }
    }

    const compactResult = await this.deps.maybeCompact({
      loopTurn: turn,
      failures: this.deps.getCompactFailures(),
    })
    if (compactResult.compacted) userMessageConsumed = true
    if (this.deps.getAbortSignal()?.aborted) {
      return { compacted: false, shouldAbort: true, userMessageConsumed }
    }
    this.deps.setCompactFailures(compactResult.failures)

    // Immune signal: surface compaction failures
    if (compactResult.failures.consecutiveFailures > 0) {
      try {
        this.deps.injectImmuneSignal({
          kind: 'compaction_fail',
          severity: Math.min(1.0, compactResult.failures.consecutiveFailures * 0.3),
          turn,
          source: 'compaction-controller',
        })
      } catch { /* non-critical */ }
    }
    if (compactResult.compacted) {
      this.deps.setLastCompactTurn(turn)
      if (typeof globalThis.gc === 'function') globalThis.gc()
    }

    // T9: Proactive Quality Compact — phase transition partial compact.
    // P2-5: only at user boundaries (turn 0).
    if (!compactResult.compacted && this.deps.getContextWindow() >= 500_000 && turn === 0) {
      const qTokens = this.deps.getEstimatedTokens()
      const qRatio = qTokens / this.deps.getContextWindow()
      const phaseHint = this.deps.getPhaseHint()
      const prevPhaseHint = this.deps.getPrevPhaseHint()
      this.deps.setPrevPhaseHint(phaseHint)
      const phaseTransition = prevPhaseHint !== undefined && phaseHint !== prevPhaseHint

      if (qRatio > 0.3 && phaseTransition) {
        const partialOk = await this.deps.tryPartialCompact(30)
        if (partialOk) {
          userMessageConsumed = true
          this.deps.setLastCompactTurn(turn)
        }
      }
    }

    // Stale round compaction: proactively shrink N-2+ tool_results
    if (!compactResult.compacted) {
      const contextWindow = this.deps.getContextWindow()
      const msgs = this.deps.getMessages()
      const tokenBudget = estimateOaiTokens(msgs as any)
      const tokenRatio = tokenBudget / contextWindow

      if ((tokenRatio >= 0.5 || this.deps.getPendingStaleCompact()) && contextWindow < 1_000_000) {
        // P2-5: history rewrites only at user boundaries (turn 0).
        if (turn !== 0) {
          if (tokenRatio >= 0.5) this.deps.setPendingStaleCompact(true)
        } else if (this.deps.shouldDelayCompact(tokenRatio >= 0.7 ? 3 : 2, { estimatedTokens: tokenBudget, contextWindow })) {
          // cache healthy — delay
        } else {
          this.deps.setPendingStaleCompact(false)
          // P3-B AgentDiet: remove redundant trajectory segments first
          const dietResult = this.deps.dietMessages(msgs)
          if (dietResult.removedCount > 0) {
            this.deps.replaceMessages(dietResult.messages)
          }

          const before = this.deps.getMessages()
          const advisorPreview = this.deps.getStalePreviewChars()
          const after = compactStaleRoundsOai(before, contextWindow, Math.max(advisorPreview, staleRoundThresholds(contextWindow).previewChars))
          if (after !== before) {
            this.deps.replaceMessages(after)
            if (typeof globalThis.gc === 'function') globalThis.gc()
          }
        }
      }
    }

    // Heap-driven forced compaction
    const heapRatio = snap
      ? snap.memory.heapUsedBytes / snap.memory.memoryLimitBytes
      : 0
    const is1M = this.deps.getContextWindow() >= 1_000_000
    const heapCompactThreshold = is1M ? 0.75 : 0.6
    const heapPressure = heapRatio >= heapCompactThreshold
    const msgCount = this.deps.getMessages().length
    if (!compactResult.compacted && (heapPressure || this.deps.getPendingHeapCompact()) && msgCount >= 10) {
      // P2-5: on 1M windows, heap micro-compact deferred to turn 0
      if (is1M && turn !== 0) {
        if (heapPressure) this.deps.setPendingHeapCompact(true)
      } else if (is1M && !heapPressure && this.deps.shouldDelayCompact(2)) {
        this.deps.setPendingHeapCompact(false)
      } else {
        this.deps.setPendingHeapCompact(false)
        const before = this.deps.getMessages()
        const contextWindow = this.deps.getContextWindow()
        const { messages: trimmed } = microCompactOai(before, contextWindow, this.deps.getEstimatedTokens())
        if (trimmed.length < before.length || trimmed !== before) {
          this.deps.replaceMessages(trimmed)
          if (typeof globalThis.gc === 'function') globalThis.gc()
          userMessageConsumed = true
        }
      }
    }

    return { compacted: compactResult.compacted, shouldAbort: false, userMessageConsumed }
  }
}
