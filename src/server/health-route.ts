/**
 * GET /health — sidecar liveness + summary counts (N1).
 *
 * Health is intentionally NOT auth-gated: the desktop shell and Rust monitor
 * need to probe it from cold-start / token-rotation windows where the Bearer
 * token may not be available yet. Rich fields (session/running counts, uptime,
 * loop lag) are the 「用户正在跑 agent」活动侧信道——带 token 的请求（Rust 壳/
 * webview 的全部真实消费方）拿全量；无 token 的匿名探测只拿 {ok, version}。
 */
import type { RouteHandler } from './index.js'
import type { RuntimeSessionManager } from './session-manager.js'
import type { LoopLagSnapshot } from './loop-health.js'
import { isAuthorizedRequest } from './auth.js'
import { PROTOCOL_VERSION } from './protocol.js'

export function buildHealthRoute(
  manager: RuntimeSessionManager,
  startedAt: number,
  version: string,
  apiToken?: string,
  registryReady?: () => boolean,
  configured?: () => boolean,
  loopLag?: () => LoopLagSnapshot,
): Record<string, RouteHandler> {
  return {
    'GET /health': (_body, _params, headers) => {
      const registryOk = registryReady ? registryReady() : true
      const configuredOk = configured?.() ?? true
      if (!isAuthorizedRequest({ headers: headers ?? {} }, apiToken)) {
        return {
          status: 200,
          body: { ok: registryOk && configuredOk, version },
        }
      }
      const { sessionCount, runningCount } = manager.stats()
      const lag = loopLag?.()
      return {
        status: 200,
        body: {
          ok: registryOk && configuredOk,
          version,
          protocolVersion: PROTOCOL_VERSION,
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
