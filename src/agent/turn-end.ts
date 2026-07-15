import type { AgentConfig } from './loop-types.js'
import type { SessionContext } from './context.js'
import type { TrajectoryRecorder } from './trajectory.js'
import type { RoutingMetricsCollector } from '../model/routing-metrics.js'
import type { EvidenceTracker, AuthoritativeGateView } from './evidence.js'
import { extractTaskState, taskStateFromTodos } from './task-state.js'
import { detectMirror } from './behavior-mirror.js'
import { inferTaskType } from '../model/task-inferrer.js'
import { recommendModelForTask } from '../model/capability.js'
import { extractDecisions } from './decision-anchor.js'
import { getTodos } from '../tools/todo.js'

export interface TurnEndDeps {
  config: AgentConfig
  session: SessionContext
  trajectory: TrajectoryRecorder
  streamedText: string
  routingMetrics: RoutingMetricsCollector
  decisions: string[]
  evidence: EvidenceTracker
}

export interface TurnEndResult {
  decisions: string[]
  gateV2?: AuthoritativeGateView
}

export function processTurnEnd(deps: TurnEndDeps): TurnEndResult {
  const { config, session, trajectory, streamedText, routingMetrics, evidence } = deps
  let decisions = [...deps.decisions]

  // The authoritative todo list is the model's own goal decomposition. Re-inject
  // it from turn 0 whenever it exists, so the model keeps seeing its own progress
  // early (not just after turn 3) — early visibility is what keeps it updating the
  // list instead of "忘了在跟". The real list survives compaction (process
  // singleton store), so re-injecting each turn also prevents post-compaction
  // "todo 退回重做". (Thread 3)
  // The trajectory heuristic is a weaker fallback and only kicks in after a few
  // turns of activity, so it stays gated behind turn > 3 when no todo exists.
  const todos = (config.getTodos ?? getTodos)()
  if (todos.length > 0) {
    // Decisions still come from the heuristic text pass (todos don't carry them).
    const heuristic = extractTaskState(trajectory.getEntries(), streamedText)
    config.promptEngine.setTaskProgress(taskStateFromTodos(todos, heuristic.decisions))
  } else if (session.getTurnCount() > 3) {
    const heuristic = extractTaskState(trajectory.getEntries(), streamedText)
    config.promptEngine.setTaskProgress(heuristic)
 }

  // behaviorMirror removed — computed but never rendered into prompt (dead plumbing)

  if (config.modelCards && config.modelCards.length > 1 && config.getCurrentModel) {
    const currentModel = config.getCurrentModel()
    const recentCalls = trajectory.getEntries().slice(-10).map(e => ({
      name: e.tool,
      isError: e.status === 'failed' || e.status === 'retried-failed',
   }))
    const inference = inferTaskType(recentCalls)
    if (inference) {
      const recommended = recommendModelForTask(inference.task, config.modelCards)
      if (recommended.model !== currentModel && config.onModelSwitch) {
        // W4-D2 producer: attach the latest verification status so the routing
        // event carries a real outcome signal (the field was previously never set).
        const latestVerification = evidence.getState().verifications.at(-1)
        routingMetrics.record({
          turn: session.getTurnCount(),
          inferredTask: inference.task,
          recommendedModel: recommended.model,
          currentModel,
          switched: true,
          reason: inference.reason,
          timestamp: Date.now(),
          ...(latestVerification ? { verificationOutcome: latestVerification.status } : {}),
       })
        try { config.onModelSwitch(recommended.model) } catch { /* non-fatal */ }
     }
   }
 }

  const newDecisions = extractDecisions(streamedText)
  for (const d of newDecisions) {
    if (!decisions.includes(d)) decisions.push(d)
 }
  if (decisions.length > 3) decisions = decisions.slice(-3)
  config.promptEngine.setDecisions(decisions)

  // Track 3 门禁合一：v2（GREEN/YELLOW/RED，归因感知）注入时为权威；
  // 评估失败时回退 undefined（v1 语义由 evidenceSummary 消费方自行推导）。
  // 门禁结论只随 evidenceSummary 流向 UI，不再渲染成 transcript 文本
  //（任务完成总结在每个无工具 final turn 都弹出，被读成"动不动就交付"——4df36bcd）。
  let gateV2: ReturnType<NonNullable<AgentConfig['deliveryGateV2']>> | undefined
  try {
    gateV2 = config.deliveryGateV2?.([...evidence.getState().filesModified])
  } catch {
    gateV2 = undefined
  }

  return { decisions, gateV2 }
}
