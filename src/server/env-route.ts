/**
 * GET /environment — host toolchain availability for the desktop setup UI.
 * Reports whether python, uv, git, node are installed, plus platform.
 */
import type { RouteHandler } from './index.js'
import { isAuthorizedRequest } from './auth.js'
import { detectEnv, type PythonEnvInfo } from '../tools/env-check.js'
import { getShellDiagnostics } from '../platform.js'

export function buildEnvRoute(apiToken?: string): Record<string, RouteHandler> {
  return {
    'GET /environment': async (body, _params, headers) => {
      if (!isAuthorizedRequest({ body, headers }, apiToken)) {
        return { status: 401, body: { error: 'Unauthorized' } }
      }
      const env = await detectEnv()
      // 填充 shell 诊断——桌面端据此决定是否弹 Git Bash 安装引导。
      const diag = getShellDiagnostics()
      env.shell = {
        kind: diag.kind,
        gitBashAvailable: diag.gitBashPath !== null,
        ...(diag.fallbackReason ? { fallbackReason: diag.fallbackReason } : {}),
      }
      return { status: 200, body: env as PythonEnvInfo }
    },
  }
}
