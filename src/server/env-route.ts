/**
 * GET /environment — host toolchain availability for the desktop setup UI.
 * Reports whether python, uv, git, node are installed, plus platform.
 */
import type { RouteHandler } from './index.js'
import { isAuthorizedRequest } from './auth.js'
import { detectEnv, type PythonEnvInfo } from '../tools/env-check.js'

export function buildEnvRoute(apiToken?: string): Record<string, RouteHandler> {
  return {
    'GET /environment': async (body, _params, headers) => {
      if (!isAuthorizedRequest({ body, headers }, apiToken)) {
        return { status: 401, body: { error: 'Unauthorized' } }
      }
      const env = await detectEnv()
      return { status: 200, body: env as PythonEnvInfo }
    },
  }
}
