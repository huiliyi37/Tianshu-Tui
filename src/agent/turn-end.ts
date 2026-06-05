import type { AgentConfig } from './loop-types.js'
import type { SessionContext } from './context.js'
import type { TrajectoryRecorder } from './trajectory.js'
import type { RoutingMetricsCollector } from '../model/routing-metrics.js'
import type { EvidenceTracker } from './evidence.js'
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
  badge: string | null
}

export function processTurnEnd(deps: TurnEndDeps): TurnEndResult {
  const { config, session, trajectory, streamedText, routingMetrics, evidence } = deps
  let decisions = [...deps.decisions]

  if (session.getTurnCount() > 3) {
    const heuristic = extractTaskState(trajectory.getEntries(), streamedText)
    // Prefer the authoritative todo list when the model is actively using it;
    // fall back to the trajectory heuristic otherwise. The real list survives
    // compaction (the store is a process singleton), so re-injecting it each
    // turn prevents post-compaction "todo 退回重做". (Thread 3)
    const todos = getTodos()
    const taskState = todos.length > 0
      ? taskStateFromTodos(todos, heuristic.decisions)
      : heuristic
    config.promptEngine.setTaskProgress(taskState)
 }

  const mirror = session.getTurnCount() > 3
    ? detectMirror(trajectory.getEntries())
    : null
  config.promptEngine.setBehaviorMirror(mirror)

  if (config.modelCards && config.modelCards.length > 1 && config.getCurrentModel) {
    const currentModel = config.getCurrentModel()
    const recentCalls = trajectory.getEntries().slice(-10).map(e => ({
      name: e.tool,
      isError: e.status === 'failed' || e.status === 'retried-failed',
   }))
    const inference = inferTaskType(recentCalls)
    if (inference) {
      const recommended = recommendModelForTask(inference.task, config.modelCards)
      config.promptEngine.setRoutingReason(`${inference.task} · ${recommended.model} ${inference.reason}`)
      if (recommended.model !== currentModel && config.onModelSwitch) {
        routingMetrics.record({
          turn: session.getTurnCount(),
          inferredTask: inference.task,
          recommendedModel: recommended.model,
          currentModel,
          switched: true,
          reason: inference.reason,
          timestamp: Date.now(),
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

  const badge = evidence.buildBadge()

  return { decisions, badge }
}
