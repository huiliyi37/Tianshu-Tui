/**
 * /config/project-trust/* — 项目授信状态查询与变更（桌面端 L3 UI 的服务端面）。
 * All routes are Bearer-gated (fail-closed), mirroring buildConfigRoutes.
 *
 *   GET    /config/project-trust          project trust status for a workspace (?cwd= → trusted/envOverride/promptDismissed/stakes)
 *   PUT    /config/project-trust          trust a workspace or dismiss its prompt ({ cwd, action: 'trust'|'dismiss' })
 *   DELETE /config/project-trust          revoke a workspace trust (?cwd=)
 *   GET    /config/project-trust/list     list trusted workspaces (realpath → trustedAt)
 *
 * 语义与 CLI 启动提示（src/cli/project-trust-prompt.ts）同源：trust / skip /
 * dismiss 三态决策；全部变更幂等。存储 <rivetHome>/project-trust.json——
 * 授信决策绝不写回仓库目录（src/config/project-trust.ts 头注）。
 * 子模块化原因：config-routes.ts 是点名巨石（source-budgets ceiling），
 * 授权路由按接缝外提，保持主注册表只降不升（2026-09，B6/L3 计划 Wave 1）。
 */
import type { RouteHandler } from './index.js'
import { isAuthorizedRequest } from './auth.js'
import { isAbsolute } from 'node:path'
import {
  isProjectTrusted,
  trustProject,
  untrustProject,
  dismissProjectTrustPrompt,
  isTrustPromptDismissed,
  listTrustedProjectEntries,
  detectProjectTrustStakes,
} from '../config/project-trust.js'

function withAuth(handler: RouteHandler, apiToken?: string): RouteHandler {
  return async (body, params, headers, res) => {
    if (!isAuthorizedRequest({ body, headers }, apiToken)) {
      return { status: 401, body: { error: 'Unauthorized' } }
    }
    return handler(body, params, headers, res)
  }
}

export function buildProjectTrustRoutes(apiToken?: string): Record<string, RouteHandler> {
  return {
    'GET /config/project-trust': withAuth((_body, params) => {
      const cwd = params?.cwd
      if (!cwd || !isAbsolute(cwd)) {
        return { status: 400, body: { error: 'cwd (absolute path) is required' } }
      }
      const env = process.env.RIVET_TRUST_PROJECT
      return {
        status: 200,
        body: {
          trusted: isProjectTrusted(cwd),
          envOverride: env === '1' ? true : env === '0' ? false : null,
          promptDismissed: isTrustPromptDismissed(cwd),
          stakes: detectProjectTrustStakes(cwd),
        },
      }
    }, apiToken),

    'PUT /config/project-trust': withAuth((body) => {
      const { cwd, action } = (body ?? {}) as { cwd?: unknown; action?: unknown }
      if (typeof cwd !== 'string' || !isAbsolute(cwd)) {
        return { status: 400, body: { error: 'cwd (absolute path) is required' } }
      }
      if (action !== 'trust' && action !== 'dismiss') {
        return { status: 400, body: { error: "action must be 'trust' or 'dismiss'" } }
      }
      if (action === 'trust') trustProject(cwd)
      else dismissProjectTrustPrompt(cwd)
      return { status: 200, body: { ok: true } }
    }, apiToken),

    'DELETE /config/project-trust': withAuth((_body, params) => {
      const cwd = params?.cwd
      if (!cwd || !isAbsolute(cwd)) {
        return { status: 400, body: { error: 'cwd (absolute path) is required' } }
      }
      untrustProject(cwd)
      return { status: 200, body: { ok: true } }
    }, apiToken),

    'GET /config/project-trust/list': withAuth(() => {
      return { status: 200, body: { trusted: listTrustedProjectEntries() } }
    }, apiToken),
  }
}
