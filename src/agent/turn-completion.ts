import type { Usage } from '../api/types.js'
import type { AgentConfig } from './loop-types.js'
import type { SessionContext } from './context.js'
import type { TrajectoryRecorder } from './trajectory.js'
import type { RoutingMetricsCollector } from '../model/routing-metrics.js'
import type { EvidenceTracker } from './evidence.js'
import { processTurnEnd } from './turn-end.js'

export interface TurnCompletionCallbacks {
  onTextDelta: (text: string) => void
  onTurnComplete: (usage: Partial<Usage>, turnNumber: number, isFinal?: boolean) => void
}

export interface TurnCompletionDeps {
  config: AgentConfig
  session: SessionContext
  trajectory: TrajectoryRecorder
  routingMetrics: RoutingMetricsCollector
  evidence: EvidenceTracker
  getStreamedText: () => string
  getDecisions: () => string[]
  setDecisions: (decisions: string[]) => void
  refreshLedger: () => void
  refreshCacheDiagnostic: (turn: number) => void
  runPostTurn: () => Promise<void>
  runBeforeComplete?: () => Promise<void>
}

export interface CompleteTurnInput {
  turn: number
  isFinal: boolean
  emitBadge?: boolean
  callbacks: TurnCompletionCallbacks
}

export class TurnCompletionController {
  constructor(private deps: TurnCompletionDeps) {}

  async complete(input: CompleteTurnInput): Promise<void> {
    const result = processTurnEnd({
      config: this.deps.config,
      session: this.deps.session,
      trajectory: this.deps.trajectory,
      streamedText: this.deps.getStreamedText(),
      routingMetrics: this.deps.routingMetrics,
      decisions: this.deps.getDecisions(),
      evidence: this.deps.evidence,
   })
    this.deps.setDecisions(result.decisions)
    if (input.emitBadge && result.badge) input.callbacks.onTextDelta('\n' + result.badge)
    this.deps.refreshLedger()
    this.deps.refreshCacheDiagnostic(input.turn)
    await this.deps.runPostTurn()
    if (input.isFinal) await this.deps.runBeforeComplete?.()
    input.callbacks.onTurnComplete(
      this.deps.session.getTotalUsage(),
      this.deps.session.getTurnCount(),
      input.isFinal,
    )
 }
}
