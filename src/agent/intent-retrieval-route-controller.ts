import { classifyIntentRetrievalRoute, type IntentRetrievalRouterConfigInput } from './intent-retrieval-router.js'
import { renderIntentRetrievalRoute, type RetrievalRoute } from './intent-retrieval-route.js'
import { type SessionStateManager } from './session-state.js'
import { type TaskContract, type TurnMode } from '../context/task-contract.js'
import { type StreamClient } from '../api/stream-client.js'
import { type OaiMessage } from '../api/oai-types.js'
import { debugLog } from '../utils/debug.js'

/**
 * Dependencies for {@link IntentRetrievalRouteController}. All AgentLoop access
 * goes through closures so the controller never imports AgentLoop. Wired in
 * loop-factory.ts.
 */
export interface IntentRetrievalRouteDeps {
  setIntentRetrievalRoute: (route: string | null) => void
  getTaskContract: () => TaskContract | undefined
  getMessages: () => OaiMessage[]
  getSessionStateManager: () => SessionStateManager | undefined
  getTurnCount: () => number
  getLastRetrievalRoute: () => RetrievalRoute | null
  setLastRetrievalRoute: (route: RetrievalRoute | null) => void
  getRouterConfig: () => IntentRetrievalRouterConfigInput
  getClient: () => StreamClient
  getModel: () => string
  getAbortSignal: () => AbortSignal | undefined
}

/**
 * Intent-retrieval routing extracted verbatim from AgentLoop (W-L5c). Builds
 * the per-turn retrieval route and injects it via setIntentRetrievalRoute. The
 * call site stays in AgentLoop.initializeRun (timing unchanged — prefix-cache
 * hardrail), this only owns the method body.
 */
export class IntentRetrievalRouteController {
  constructor(private readonly deps: IntentRetrievalRouteDeps) {}

  async buildForTurn(userInput: string, actionable: boolean, turnMode: TurnMode = 'task'): Promise<void> {
    const taskContract = this.deps.getTaskContract()
    if (!actionable || !taskContract) {
      this.deps.setIntentRetrievalRoute(null)
      return
    }

    try {
      const messages = this.deps.getMessages()
      const lastAssistant = this.getLastAssistantMessageContent(messages) || undefined
      const sessionStateManager = this.deps.getSessionStateManager()
      if (lastAssistant && sessionStateManager) {
        sessionStateManager.extractTaskList(lastAssistant, this.deps.getTurnCount())
      }
      if (sessionStateManager) {
        const referenced = userInput.match(/\b([PpTtSs]\d+)\b/g)
        if (referenced) {
          const turn = this.deps.getTurnCount()
          for (const ref of new Set(referenced.map(r => r.toUpperCase()))) {
            sessionStateManager.updateTaskListItem(ref, 'in_progress', turn)
          }
        }
      }
      // followUp mode: pass previous route's taskKinds for inheritance
      const previousRoute = this.deps.getLastRetrievalRoute()
      const inheritedTaskKinds = turnMode === 'followUp' && previousRoute ? previousRoute.taskKinds : undefined
      const route = await classifyIntentRetrievalRoute({
        userMessage: userInput,
        lastAssistantMessage: lastAssistant,
        taskList: sessionStateManager?.getTaskList(),
        taskContract,
        inheritedTaskKinds,
        config: this.deps.getRouterConfig(),
        client: this.deps.getClient(),
        model: this.deps.getModel(),
        signal: this.deps.getAbortSignal(),
        onTelemetry: telemetry => {
          debugLog(`[intent-router] mode=${turnMode} classifier=${telemetry.classifier} fallback=${telemetry.fallbackUsed} kinds=${telemetry.taskKinds.join(',')} sources=${telemetry.sources.join(',')} directions=${telemetry.directionCount} latencyMs=${telemetry.latencyMs}`)
        },
      })
      this.deps.setLastRetrievalRoute(route)
      this.deps.setIntentRetrievalRoute(
        route && route.confidence >= 0.6 ? renderIntentRetrievalRoute(route) : null
      )
    } catch (err) {
      debugLog(`[intent-router] failed: ${(err as Error).message}`)
      this.deps.setIntentRetrievalRoute(null)
    }
  }

  private getLastAssistantMessageContent(messages: OaiMessage[]): string | null {
    for (let i = messages.length - 1; i >= 0; i--) {
      const msg = messages[i]
      if (msg?.role === 'assistant' && typeof msg.content === 'string') {
        return msg.content
      }
    }
    return null
  }
}
