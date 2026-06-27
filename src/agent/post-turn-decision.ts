import type { TurnStateBag } from './turn-orchestrator.js'
import type { AgentCallbacks } from './loop-types.js'
import type { CompleteTurnParams } from './turn-orchestrator.js'
import { evaluateThinkingRetry } from './thinking-retry.js'
import { evaluatePhantomContinuation } from './phantom-continuation.js'
import { rejectOnAbort } from './turn-boundary-abort.js'

// ── Types ──

/** The subset of TurnStateBag this controller reads/writes. Declared as a Pick
 *  so the factory can pass a partial bag (only these 5 fields) without an `as any`
 *  escape — the controller never touches the other 14 state fields. */
export type PostTurnState = Pick<TurnStateBag,
  'streamedText' | 'thinkingOnlyRetries' | 'lastThinkingContent' | 'taskContract' | 'autoContinueCount'>

export interface PostTurnDecisionDeps {
  state: PostTurnState
  getMaxAutoContinue: () => number
  getDoomLoopLevel: () => 'none' | 'warn' | 'blocked'
  appendSystemReminder: (content: string) => void
  completeTurn: (params: CompleteTurnParams) => Promise<void>
  getTotalUsage: () => import('../api/types.js').Usage
  getTurnCount: () => number
  /** GLM independent reasoning mode: disable thinking-only retry.
   *  GLM's deep reasoning without tools/text is a legitimate turn output,
   *  not a failed utterance — retrying only wastes time with fresh reasoning. */
  skipThinkingRetry?: boolean
}

export type ThinkingRetryResult =
  | { shouldRetry: true }
  | { shouldRetry: false }

export type PhantomContinuationResult =
  | { shouldContinue: true }
  | { shouldContinue: false }

// ── Controller ──

export class PostTurnDecisionController {
  constructor(private deps: PostTurnDecisionDeps) {}

  /**
   * Check if the turn produced only thinking (no text, no tools) and should be retried.
   * Returns true if a retry was triggered (caller should `continue` the loop).
   * Internally handles state writes, reminder injection, and turn archival.
   */
  async evaluateThinkingRetry(params: {
    collectedBlockCount: number
    thinkingAccum: string
    turn: number
    callbacks: AgentCallbacks
    signal: AbortSignal
  }): Promise<ThinkingRetryResult> {
    if (this.deps.skipThinkingRetry) return { shouldRetry: false }
    const result = evaluateThinkingRetry({
      streamedText: this.deps.state.streamedText,
      collectedBlockCount: params.collectedBlockCount,
      thinkingAccum: params.thinkingAccum,
      thinkingOnlyRetries: this.deps.state.thinkingOnlyRetries,
      lastThinkingContent: this.deps.state.lastThinkingContent,
    })
    this.deps.state.lastThinkingContent = result.nextState.lastThinkingContent
    this.deps.state.thinkingOnlyRetries = result.nextState.thinkingOnlyRetries
    if (result.shouldRetry) {
      this.deps.appendSystemReminder(result.retryMessage)
      params.callbacks.onTurnComplete(this.deps.getTotalUsage(), this.deps.getTurnCount(), false)
      return { shouldRetry: true }
    }
    return { shouldRetry: false }
  }

  /**
   * Check if a no-tool turn should auto-continue via phantom continuation.
   * Returns true if continuation was triggered (caller should `continue` the loop).
   * Internally handles state writes, completeTurn, and reminder injection.
   */
  async evaluatePhantomContinuation(params: {
    turn: number
    callbacks: AgentCallbacks
    signal: AbortSignal
  }): Promise<PhantomContinuationResult> {
    const phantom = evaluatePhantomContinuation({
      streamedText: this.deps.state.streamedText,
      activeContract: this.deps.state.taskContract,
      autoContinueCount: this.deps.state.autoContinueCount,
      maxAutoContinue: this.deps.getMaxAutoContinue(),
      convergenceEscalated: this.deps.getDoomLoopLevel() !== 'none',
    })
    if (phantom.shouldContinue) {
      this.deps.state.autoContinueCount = this.deps.state.autoContinueCount + 1
      await rejectOnAbort(
        this.deps.completeTurn({ turn: params.turn, isFinal: false, callbacks: params.callbacks }),
        params.signal,
        'phantom-continue-complete',
      )
      this.deps.appendSystemReminder(phantom.message)
      return { shouldContinue: true }
    }
    return { shouldContinue: false }
  }
}
