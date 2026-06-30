/**
 * GET /project-templates/status  — check whether a project needs first-run template init.
 * POST /project-templates/apply  — apply .rivet.md / AGENTS.md templates and record sentinel.
 *
 * Mirrors the TUI first-run prompt in `src/main.ts`, but exposed as HTTP routes
 * so the desktop UI can drive the same flow with a modal/banner.
 */
import type { RouteHandler } from './index.js'
import { isAuthorizedRequest } from './auth.js'
import {
  needsTemplatesInit,
  applyProjectTemplates,
  recordTemplatesDecision,
  AGENTS_MD_TEMPLATE,
  RIVET_MD_TEMPLATE,
  type ApplyTemplatesOptions,
  type ApplyTemplatesResult,
} from '../bootstrap/project-templates.js'

export interface ProjectTemplatesStatus {
  needsInit: boolean
  cwd: string
  agentsTemplate: string
  rivetTemplate: string
}

export interface ProjectTemplatesApplyBody {
  cwd: string
  agentsMode: ApplyTemplatesOptions['agentsMode']
}

export function buildProjectTemplatesRoutes(apiToken?: string): Record<string, RouteHandler> {
  return {
    'GET /project-templates/status': (body, params, headers) => {
      if (!isAuthorizedRequest({ body, headers }, apiToken)) {
        return { status: 401, body: { error: 'Unauthorized' } }
      }
      const cwd = typeof params?.cwd === 'string' ? params.cwd : ''
      if (!cwd) return { status: 400, body: { error: 'Missing cwd query parameter' } }
      const status: ProjectTemplatesStatus = {
        needsInit: needsTemplatesInit(cwd),
        cwd,
        agentsTemplate: AGENTS_MD_TEMPLATE,
        rivetTemplate: RIVET_MD_TEMPLATE,
      }
      return { status: 200, body: status }
    },

    'POST /project-templates/apply': (body, _params, headers) => {
      if (!isAuthorizedRequest({ body, headers }, apiToken)) {
        return { status: 401, body: { error: 'Unauthorized' } }
      }
      const input = body as ProjectTemplatesApplyBody
      const cwd = typeof input?.cwd === 'string' ? input.cwd : ''
      const agentsMode = input?.agentsMode ?? 'overwrite'
      if (!cwd) return { status: 400, body: { error: 'Missing cwd' } }
      if (!['overwrite', 'append', 'skip'].includes(agentsMode)) {
        return { status: 400, body: { error: 'Invalid agentsMode' } }
      }

      const result: ApplyTemplatesResult = applyProjectTemplates(cwd, { agentsMode })
      const decision = agentsMode === 'skip' ? 'declined' : 'created'
      recordTemplatesDecision(cwd, decision, {
        created: result.created,
        appended: result.appended,
        skipped: result.skipped,
      })
      return { status: 200, body: { ...result, decision } }
    },
  }
}
