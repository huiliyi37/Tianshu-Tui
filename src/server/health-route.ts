/**
 * GET /health — sidecar liveness + summary counts (N1). Bearer-gated like the
 * rest of the API; the desktop uses it to drive the crash-reconnect banner.
 */
import type { RouteHandler } from './index.js'
import { isAuthorizedRequest } from './auth.js'
import type { RuntimeSessionManager } from './session-manager.js'

export function buildHealthRoute(
  manager: RuntimeSessionManager,
  startedAt: number,
  version: string,
  apiToken?: string,
  /**
   * Whether the shared SessionRegistry has finished its async init. When
   * omitted (tests / single-session paths) it reports `true`, so callers that
   * don't run a registry see a healthy sidecar.
   */
  registryReady?: () => boolean,
  /** Whether the default provider has a usable API key. false = setup mode. */
  configured = true,
): Record<string, RouteHandler> {
  return {
    'GET /health': (body, _params, headers) => {
      if (!isAuthorizedRequest({ body, headers }, apiToken)) {
        return { status: 401, body: { error: 'Unauthorized' } }
      }
      const { sessionCount, runningCount } = manager.stats()
      return {
        status: 200,
        body: {
          ok: true,
          version,
          uptimeMs: Date.now() - startedAt,
          sessionCount,
          runningCount,
          registryOk: registryReady ? registryReady() : true,
          configured,
        },
      }
    },
  }
}
