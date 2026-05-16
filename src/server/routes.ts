import type { RouteHandler } from './index.js'

export interface ServerState {
  running: boolean
  sessionId?: string
  abort?: () => void
}

export function createRoutes(state: ServerState): Record<string, RouteHandler> {
  return {
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
}
