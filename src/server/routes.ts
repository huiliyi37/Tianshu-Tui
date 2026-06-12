import type { RouteHandler } from './index.js'
import type { PromptRouteDeps } from './prompt-route.js'
import { buildPromptHandler } from './prompt-route.js'
import { buildTaskRoutes, type TaskRoutesDeps } from './task-routes.js'
import { isAuthorizedRequest } from './auth.js'

export interface BanditStatusEntry {
  source: string
  mode: string
  enabled: boolean
  reason: string
  totalShadowSamples: number
}

export interface ServerState {
  running: boolean
  sessionId?: string
  abort?: () => void
  /** Shared Bearer token for all server routes. Missing token means fail-closed. */
  apiToken?: string
  /** T5: bandit promotion state for /status observability. */
  banditState?: BanditStatusEntry[]
}

function unauthorized() {
  return { status: 401, body: { error: 'Unauthorized' } }
}

function withAuth(handler: RouteHandler, apiToken?: string): RouteHandler {
  return async (body, params, headers, res) => {
    if (!isAuthorizedRequest({ body, headers }, apiToken)) return unauthorized()
    return handler(body, params, headers, res)
  }
}

export function createRoutes(state: ServerState, deps?: PromptRouteDeps, taskDeps?: TaskRoutesDeps): Record<string, RouteHandler> {
  const apiToken = state.apiToken ?? taskDeps?.apiToken
  const routes: Record<string, RouteHandler> = {
    'GET /status': withAuth(() => ({
      status: 200,
      body: {
        running: state.running,
        sessionId: state.sessionId ?? null,
        ...(state.banditState ? { bandit: state.banditState } : {}),
      },
    }), apiToken),

    'POST /abort': withAuth(() => {
      state.abort?.()
      state.running = false
      return { status: 200, body: { aborted: true } }
    }, apiToken),
  }

  if (deps) {
    routes['POST /prompt'] = withAuth(buildPromptHandler(deps), apiToken)
  }

  if (taskDeps) {
    Object.assign(routes, buildTaskRoutes({ ...taskDeps, apiToken: taskDeps.apiToken ?? apiToken }))
  }

  return routes
}
