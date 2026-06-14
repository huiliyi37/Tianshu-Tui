/**
 * /sessions/* routes — the desktop-facing multi-session API surface over
 * RuntimeSessionManager. Every route is Bearer-gated (fail-closed).
 *
 *   POST   /sessions                                   create (+optional prompt)
 *   GET    /sessions                                   list
 *   GET    /sessions/:id                               one record
 *   POST   /sessions/:id/prompt                        start a run
 *   POST   /sessions/:id/abort                         abort
 *   GET    /sessions/:id/events?since=N                replay tail (B3)
 *   GET    /sessions/:id/stream?since=N                live SSE (B3)
 *   POST   /sessions/:id/interventions/:rid/answer     resolve approval/intent (B2)
 *   GET    /sessions/:id/artifacts                     list (B4)
 *   GET    /sessions/:id/artifacts/:artifactId         read raw (B4)
 */
import type { RouteHandler } from './index.js'
import { isAuthorizedRequest } from './auth.js'
import { SseStream } from './sse-stream.js'
import type { RuntimeSessionManager } from './session-manager.js'
import type { Artifact } from '../artifact/types.js'

export type ArtifactKind = 'plan' | 'task-list' | 'walkthrough' | 'diff' | 'screenshot' | 'test-result'

export function classifyArtifact(a: Artifact): ArtifactKind {
  const tool = a.tool.toLowerCase()
  const target = a.target.toLowerCase()
  if (tool.includes('plan') || target.includes('plan')) return 'plan'
  if (tool.includes('todo') || tool.includes('task')) return 'task-list'
  if (/\.(png|jpe?g|gif|webp)$/.test(target) || tool.includes('screenshot')) return 'screenshot'
  if (
    tool === 'edit_file' ||
    tool === 'write_file' ||
    tool.includes('diff') ||
    /\.(diff|patch)$/.test(target)
  ) {
    return 'diff'
  }
  if (tool.includes('test') || target.includes('test') || tool === 'run_tests') return 'test-result'
  return 'walkthrough'
}

function artifactSummary(a: Artifact) {
  return {
    id: a.id,
    tool: a.tool,
    target: a.target,
    kind: classifyArtifact(a),
    summary: a.summary,
    charCount: a.charCount,
    lineCount: a.lineCount,
    createdAt: a.createdAt,
  }
}

function withAuth(handler: RouteHandler, apiToken?: string): RouteHandler {
  return async (body, params, headers, res) => {
    if (!isAuthorizedRequest({ body, headers }, apiToken)) {
      return { status: 401, body: { error: 'Unauthorized' } }
    }
    return handler(body, params, headers, res)
  }
}

export function buildSessionRoutes(
  manager: RuntimeSessionManager,
  apiToken?: string,
): Record<string, RouteHandler> {
  const routes: Record<string, RouteHandler> = {
    'POST /sessions': withAuth((body) => {
      const data = (body ?? {}) as { cwd?: string; title?: string; prompt?: string }
      const rec = manager.createSession({ cwd: data.cwd, title: data.title, prompt: data.prompt })
      return { status: 201, body: rec }
    }, apiToken),

    'GET /sessions': withAuth(() => ({
      status: 200,
      body: { sessions: manager.listSessions() },
    }), apiToken),

    'GET /sessions/:id': withAuth((_body, params) => {
      const rec = manager.getSession(params!.id!)
      if (!rec) return { status: 404, body: { error: 'Session not found' } }
      return { status: 200, body: rec }
    }, apiToken),

    'POST /sessions/:id/prompt': withAuth((body, params) => {
      const data = (body ?? {}) as { prompt?: string }
      if (!data.prompt || typeof data.prompt !== 'string' || !data.prompt.trim()) {
        return { status: 400, body: { error: 'Missing or empty "prompt" field' } }
      }
      const ok = manager.run(params!.id!, data.prompt)
      if (!ok) return { status: 409, body: { error: 'Session is missing or already running' } }
      return { status: 200, body: manager.getSession(params!.id!) }
    }, apiToken),

    'POST /sessions/:id/abort': withAuth((_body, params) => {
      const ok = manager.abort(params!.id!)
      if (!ok) return { status: 404, body: { error: 'Session not found' } }
      return { status: 200, body: { aborted: true } }
    }, apiToken),

    'GET /sessions/:id/events': withAuth((_body, params) => {
      const since = Number(params?.since ?? 0) || 0
      const result = manager.getEvents(params!.id!, since)
      if (!result) return { status: 404, body: { error: 'Session not found' } }
      return { status: 200, body: result }
    }, apiToken),

    'GET /sessions/:id/stream': withAuth((_body, params, _headers, res) => {
      if (!res) return { status: 500, body: { error: 'SSE response stream is unavailable' } }
      const id = params!.id!
      const since = Number(params?.since ?? 0) || 0
      const existing = manager.getEvents(id, since)
      if (!existing) return { status: 404, body: { error: 'Session not found' } }

      const sse = new SseStream(res)
      for (const ev of existing.events) sse.send(ev.type, ev)
      const unsubscribe = manager.subscribe(id, (ev) => sse.send(ev.type, ev))
      res.on('close', () => unsubscribe?.())
      return { status: 200, handled: true }
    }, apiToken),

    'POST /sessions/:id/interventions/:requestId/answer': withAuth((body, params) => {
      const data = (body ?? {}) as { decision?: string; editedInput?: Record<string, unknown> }
      const decision = data.decision ?? 'approve'
      const ok = manager.answerIntervention(params!.id!, params!.requestId!, decision, data.editedInput)
      if (!ok) return { status: 404, body: { error: 'Pending intervention not found' } }
      return { status: 200, body: { ok: true } }
    }, apiToken),

    'POST /sessions/:id/feedback': withAuth((body, params) => {
      const data = (body ?? {}) as { artifactId?: string; comment?: string }
      if (!data.artifactId || !data.comment || !data.comment.trim()) {
        return { status: 400, body: { error: 'Missing "artifactId" or "comment"' } }
      }
      const ok = manager.feedback(params!.id!, data.artifactId, data.comment.trim())
      if (!ok) return { status: 409, body: { error: 'Session is missing or already running' } }
      return { status: 200, body: manager.getSession(params!.id!) }
    }, apiToken),

    'GET /sessions/:id/artifacts': withAuth((_body, params) => {
      const list = manager.listArtifacts(params!.id!)
      if (!list) return { status: 404, body: { error: 'Session not found' } }
      return { status: 200, body: { artifacts: list.map(artifactSummary) } }
    }, apiToken),

    'GET /sessions/:id/artifacts/:artifactId': withAuth(async (_body, params) => {
      const id = params!.id!
      const artifactId = params!.artifactId!
      const list = manager.listArtifacts(id)
      if (!list) return { status: 404, body: { error: 'Session not found' } }
      const found = list.find((a) => a.id === artifactId)
      if (!found) return { status: 404, body: { error: 'Artifact not found' } }
      const raw = await manager.readArtifact(id, artifactId)
      return { status: 200, body: { artifact: artifactSummary(found), raw: raw ?? '' } }
    }, apiToken),
  }

  return routes
}
