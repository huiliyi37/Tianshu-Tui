/**
 * GET /environment — host toolchain availability for the desktop setup UI.
 * Reports whether python, uv, git, node are installed, plus platform.
 */
import type { RouteHandler } from './index.js'
import { isAuthorizedRequest } from './auth.js'
import { detectEnv, type PythonEnvInfo } from '../tools/env-check.js'
import { getShellDiagnostics } from '../platform.js'
import { execSync } from 'node:child_process'

export function buildEnvRoute(apiToken?: string): Record<string, RouteHandler> {
  return {
    'GET /environment': async (body, _params, headers) => {
      if (!isAuthorizedRequest({ body, headers }, apiToken)) {
        return { status: 401, body: { error: 'Unauthorized' } }
      }
      const env = await detectEnv()
      const diag = getShellDiagnostics()
      env.shell = {
        kind: diag.kind,
        gitBashAvailable: diag.gitBashPath !== null,
        ...(diag.fallbackReason ? { fallbackReason: diag.fallbackReason } : {}),
      }
      return { status: 200, body: env as PythonEnvInfo }
    },

    'POST /config/fix-autocrlf': withAuthPost((_body, _params, _headers) => {
      // One-click fix: git config --global core.autocrlf input
      // Prevents CRLF noise in diffs when the agent writes LF.
      try {
        execSync('git config --global core.autocrlf input', { timeout: 5000 })
        return { status: 200, body: { ok: true } }
      } catch (err) {
        return { status: 500, body: { error: (err as Error).message } }
      }
    }, apiToken),
  }
}

function withAuthPost(handler: RouteHandler, apiToken?: string): RouteHandler {
  return async (body, params, headers, res) => {
    if (!isAuthorizedRequest({ body, headers }, apiToken)) {
      return { status: 401, body: { error: 'Unauthorized' } }
    }
    return handler(body, params, headers, res)
  }
}
