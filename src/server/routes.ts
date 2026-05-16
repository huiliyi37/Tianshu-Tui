import type { RouteHandler } from './index.js'
import type { PromptRouteDeps } from './prompt-route.js'
import { buildPromptHandler } from './prompt-route.js'

export interface ServerState {
  running: boolean
  sessionId?: string
  abort?: () => void
}

export function createRoutes(state: ServerState, deps?: PromptRouteDeps): Record<string, RouteHandler> {
  const routes: Record<string, RouteHandler> = {
    'GET /status': () => ({
      status: 200,
      body: { running: state.running, sessionId: state.sessionId ?? null },
    }),

    'POST /abort': () => {
      state.abort?.()
      state.running = false
      return { status: 200, body: { aborted: true } }
    },
  }

  if (deps) {
    routes['POST /prompt'] = buildPromptHandler(deps)
  }

  return routes
}
