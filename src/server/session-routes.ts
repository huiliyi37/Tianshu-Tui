/**
 * /sessions/* routes — the desktop-facing multi-session API surface over
 * RuntimeSessionManager. Every route is Bearer-gated (fail-closed).
 *
 *   POST   /sessions                                   create (+optional prompt)
 *   GET    /sessions                                   list
 *   GET    /sessions/:id                               one record
 *   POST   /sessions/:id/prompt                        start a run
 *   POST   /sessions/:id/steer                         queue mid-run guidance (T3)
 *   POST   /sessions/:id/abort                         abort
 *   GET    /sessions/:id/events?since=N                replay tail (B3)
 *   GET    /sessions/:id/files?q=&limit=                @file mention picker (D2)
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
import type { SessionRegistry } from '../agent/session-registry.js'
import type { ApprovalMode } from '../agent/loop-types.js'
import type { PlanDocument } from '../plan/plan-store.js'
import { getRollbackPreview, rollbackToCheckpoint, makeOwnershipGuard } from '../agent/checkpoint.js'
import { listProjectFiles, rankFiles } from './file-list.js'

export type ArtifactKind = 'plan' | 'task-list' | 'walkthrough' | 'diff' | 'screenshot' | 'test-result'

/** S — accepted autonomy levels for per-session approval-mode overrides. */
const APPROVAL_MODES: ReadonlySet<ApprovalMode> = new Set<ApprovalMode>([
  'auto-accept', 'auto-safe', 'manual', 'dangerously-skip-permissions',
])
const isApprovalMode = (v: unknown): v is ApprovalMode =>
  typeof v === 'string' && APPROVAL_MODES.has(v as ApprovalMode)

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

/** Plan slugs may contain CJK (slugify allows \u4e00-\u9fff); URLs encode them. */
function decodeSlug(raw: string): string {
  try { return decodeURIComponent(raw) } catch { return raw }
}

/** Plan list entry — summary only (no markdown body), createdAt as epoch ms. */
function planSummary(p: PlanDocument) {
  return {
    slug: p.slug,
    title: p.title,
    status: p.status,
    path: p.path,
    createdAt: p.createdAt instanceof Date ? p.createdAt.getTime() : p.createdAt,
    approvedAt: p.approvedAt instanceof Date ? p.approvedAt.getTime() : p.approvedAt,
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
  getRegistry?: () => SessionRegistry | undefined,
): Record<string, RouteHandler> {
  // R3 — build an OwnershipGuard scoped to one session so rollback never
  // restores files a *different* live session exclusively owns. Returns
  // undefined when no registry is wired (single-session / CLI path).
  const guardFor = (sessionId: string, cwd: string) => {
    const registry = getRegistry?.()
    return registry ? makeOwnershipGuard(registry, sessionId, cwd) : undefined
  }

  const routes: Record<string, RouteHandler> = {
    'POST /sessions': withAuth((body) => {
      const data = (body ?? {}) as { cwd?: string; title?: string; prompt?: string; approvalMode?: unknown }
      if (data.approvalMode !== undefined && !isApprovalMode(data.approvalMode)) {
        return { status: 400, body: { error: 'Invalid "approvalMode"' } }
      }
      const rec = manager.createSession({
        cwd: data.cwd,
        title: data.title,
        prompt: data.prompt,
        approvalMode: data.approvalMode as ApprovalMode | undefined,
      })
      return { status: 201, body: rec }
    }, apiToken),

    // S — switch a session's autonomy level (监督 / 默认 / 自治). Live-mutates a
    // running agent's approval mode and persists onto the record. Bearer-gated.
    'POST /sessions/:id/approval-mode': withAuth((body, params) => {
      const id = params!.id!
      const data = (body ?? {}) as { approvalMode?: unknown }
      if (!isApprovalMode(data.approvalMode)) {
        return { status: 400, body: { error: 'Invalid or missing "approvalMode"' } }
      }
      if (!manager.setApprovalMode(id, data.approvalMode)) {
        return { status: 404, body: { error: 'Session not found' } }
      }
      return { status: 200, body: { id, approvalMode: data.approvalMode } }
    }, apiToken),

    // Plan mode — toggle the session into read-only planning ('planning') or back
    // to normal execution ('off'). Emits a plan_mode event for live viewers.
    'POST /sessions/:id/plan-mode': withAuth((body, params) => {
      const id = params!.id!
      const data = (body ?? {}) as { state?: unknown }
      if (data.state !== 'off' && data.state !== 'planning') {
        return { status: 400, body: { error: 'Invalid or missing "state" (off|planning)' } }
      }
      if (!manager.setPlanMode(id, data.state)) {
        return { status: 404, body: { error: 'Session not found' } }
      }
      return { status: 200, body: { id, planMode: data.state } }
    }, apiToken),

    // Plan list — this session's plans (newest first), summary only (no content).
    'GET /sessions/:id/plans': withAuth(async (_body, params) => {
      const plans = await manager.listPlans(params!.id!)
      if (!plans) return { status: 404, body: { error: 'Session not found' } }
      return { status: 200, body: { plans: plans.map(planSummary) } }
    }, apiToken),

    // Plan read — full markdown content for one plan.
    'GET /sessions/:id/plans/:slug': withAuth(async (_body, params) => {
      const plan = await manager.readPlan(params!.id!, decodeSlug(params!.slug!))
      if (plan === undefined) return { status: 404, body: { error: 'Session not found' } }
      if (!plan) return { status: 404, body: { error: 'Plan not found' } }
      return { status: 200, body: { plan } }
    }, apiToken),

    // Build — approve a plan and inject it as the next turn for execution.
    'POST /sessions/:id/plans/:slug/approve': withAuth(async (_body, params) => {
      const ok = await manager.approvePlan(params!.id!, decodeSlug(params!.slug!))
      if (!ok) {
        return { status: 409, body: { error: 'Session missing/running or plan not found' } }
      }
      return { status: 200, body: { ok: true } }
    }, apiToken),

    // Reject — mark a plan rejected (kept on disk) with optional revision feedback.
    'POST /sessions/:id/plans/:slug/reject': withAuth(async (body, params) => {
      const data = (body ?? {}) as { comment?: string }
      const ok = await manager.rejectPlan(params!.id!, decodeSlug(params!.slug!), data.comment)
      if (!ok) return { status: 404, body: { error: 'Session or plan not found' } }
      return { status: 200, body: { ok: true } }
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
      const data = (body ?? {}) as { prompt?: string; images?: unknown }
      if (!data.prompt || typeof data.prompt !== 'string' || !data.prompt.trim()) {
        return { status: 400, body: { error: 'Missing or empty "prompt" field' } }
      }
      // Validate images: must be an array of data:image/...;base64,... URLs.
      let images: string[] | undefined
      if (data.images !== undefined) {
        if (!Array.isArray(data.images) || data.images.length === 0) {
          return { status: 400, body: { error: '"images" must be a non-empty array' } }
        }
        if (data.images.length > 4) {
          return { status: 400, body: { error: 'Max 4 images allowed' } }
        }
        for (const img of data.images) {
          if (typeof img !== 'string' || !img.startsWith('data:image/')) {
            return { status: 400, body: { error: 'Each image must be a data:image/... URL' } }
          }
        }
        images = data.images as string[]
      }
      const ok = manager.run(params!.id!, data.prompt, images)
      if (!ok) return { status: 409, body: { error: 'Session is missing or already running' } }
      return { status: 200, body: manager.getSession(params!.id!) }
    }, apiToken),

    // T3 — mid-run steering. Queues user guidance into a RUNNING session's steer
    // buffer; injected at the next tool boundary (no new turn). Idle → 409 so the
    // desktop knows to use /prompt instead. Bearer-gated.
    'POST /sessions/:id/steer': withAuth((body, params) => {
      const data = (body ?? {}) as { text?: string }
      if (!data.text || typeof data.text !== 'string' || !data.text.trim()) {
        return { status: 400, body: { error: 'Missing or empty "text" field' } }
      }
      const result = manager.steer(params!.id!, data.text.trim())
      if (result === 'not_found') return { status: 404, body: { error: 'Session not found' } }
      if (result === 'idle') {
        return { status: 409, body: { error: 'Session is not running; use /prompt to start a turn' } }
      }
      return { status: 200, body: { queued: true } }
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

    // @file mention picker (D2) — enumerate project files under the session's
    // cwd, ranked by an optional ?q substring/fuzzy query. Scoped to cwd, never
    // follows symlinks, honors gitignore + silent-layer filters. Bearer-gated.
    'GET /sessions/:id/files': withAuth(async (_body, params) => {
      const rec = manager.getSession(params!.id!)
      if (!rec) return { status: 404, body: { error: 'Session not found' } }
      const q = typeof params?.q === 'string' ? params.q : ''
      const limit = Math.min(Math.max(Number(params?.limit ?? 50) || 50, 1), 200)
      const all = await listProjectFiles(rec.cwd)
      return { status: 200, body: { files: rankFiles(all, q, limit) } }
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
      // Keepalive: a 30s comment heartbeat stops idle proxies from reaping the
      // connection and detects a half-dead socket (write throws → sse closes).
      // unref so the timer never keeps the process (or a test) alive on its own.
      const keepalive = setInterval(() => sse.ping(), 30_000)
      if (typeof keepalive.unref === 'function') keepalive.unref()
      res.on('close', () => {
        clearInterval(keepalive)
        unsubscribe?.()
        sse.close()
      })
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

    // R3 — rollback preview. Returns the agent-owned files that would be
    // restored, files skipped because a peer session owns them, AND any
    // irreversible bash side effects file rollback CANNOT undo. The returned
    // confirmationToken must be echoed back to POST /rollback.
    'GET /sessions/:id/rollback/preview': withAuth(async (_body, params) => {
      const id = params!.id!
      const rec = manager.getSession(id)
      if (!rec) return { status: 404, body: { error: 'Session not found' } }
      const preview = await getRollbackPreview(rec.cwd, id, guardFor(id, rec.cwd))
      if (!preview) return { status: 200, body: { available: false } }
      return { status: 200, body: { available: true, ...preview } }
    }, apiToken),

    // R3 — execute rollback. Requires the confirmationToken from preview. Only
    // this session's own touched files are restored; contested files are skipped
    // and surfaced, and irreversible effects are reported (never silently undone).
    'POST /sessions/:id/rollback': withAuth(async (body, params) => {
      const id = params!.id!
      const rec = manager.getSession(id)
      if (!rec) return { status: 404, body: { error: 'Session not found' } }
      const data = (body ?? {}) as { confirmationToken?: string }
      if (!data.confirmationToken) {
        return { status: 400, body: { error: 'Missing "confirmationToken" (get one from rollback/preview)' } }
      }
      const result = await rollbackToCheckpoint(rec.cwd, data.confirmationToken, id, guardFor(id, rec.cwd))
      if (!result.success) {
        return { status: 409, body: { error: 'Rollback failed or nothing to restore', ...result } }
      }
      return { status: 200, body: result }
    }, apiToken),

    // ── Rewind: list user messages that can be rewound to ──
    'GET /sessions/:id/rewind-points': withAuth((_body, params) => {
      const points = manager.listRewindPoints(params!.id!)
      if (!points) return { status: 404, body: { error: 'Session not found' } }
      return { status: 200, body: { points } }
    }, apiToken),

    // ── Rewind: truncate conversation to a prior message index ──
    'POST /sessions/:id/rewind': withAuth((body, params) => {
      const data = (body ?? {}) as { messageIndex?: number; rollbackFiles?: boolean }
      if (typeof data.messageIndex !== 'number' || data.messageIndex < 0) {
        return { status: 400, body: { error: 'Missing or invalid "messageIndex"' } }
      }
      const ok = manager.rewind(params!.id!, data.messageIndex, { rollbackFiles: data.rollbackFiles === true })
      if (!ok) {
        const rec = manager.getSession(params!.id!)
        if (!rec) return { status: 404, body: { error: 'Session not found' } }
        return { status: 409, body: { error: 'Session is running, has no agent, or index out of range' } }
      }
      return { status: 200, body: { ok: true, ...manager.getSession(params!.id!) } }
    }, apiToken),
  }

  return routes
}
