/**
 * GET /health — sidecar liveness + summary counts (N1).
 *
 * Health is intentionally NOT auth-gated: the desktop shell and Rust monitor
 * need to probe it from cold-start / token-rotation windows where the Bearer
 * token may not be available yet. The response carries no user data (uptime,
 * session/running counts, loop lag) so there is no confidentiality risk.
 */
import type { RouteHandler } from './index.js'
import type { RuntimeSessionManager } from './session-manager.js'
import type { LoopLagSnapshot } from './loop-health.js'

export function buildHealthRoute(
  manager: RuntimeSessionManager,
  startedAt: number,
  version: string,
  _apiToken?: string,
  registryReady?: () => boolean,
  configured?: () => boolean,
  loopLag?: () => LoopLagSnapshot,
): Record<string, RouteHandler> {
  return {
    'GET /health': (_body, _params, _headers) => {
      const { sessionCount, runningCount } = manager.stats()
      const lag = loopLag?.()
      const registryOk = registryReady ? registryReady() : true
      const configuredOk = configured?.() ?? true
      return {
        status: 200,
        body: {
          ok: registryOk && configuredOk,
          version,
          uptimeMs: Date.now() - startedAt,
          sessionCount,
          runningCount,
          registryOk,
          configured: configuredOk,
          ...(lag ? { loopLagP99Ms: lag.p99Ms, loopLagMaxMs: lag.maxMs } : {}),
        },
      }
    },
  }
}
