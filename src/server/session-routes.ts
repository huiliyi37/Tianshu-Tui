/**
 * /sessions/* routes — the desktop-facing multi-session API surface over
 * RuntimeSessionManager. Every route is Bearer-gated (fail-closed).
 *
 *   POST   /sessions                                   create (+optional prompt)
 *   GET    /sessions                                   list
 *   DELETE /sessions/:id                               archive (soft-close)
 *   POST   /sessions/:id/unarchive                     restore an archived session
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
 *   GET    /worktrees                                  list git worktrees
 *   GET    /github/prs                                 list open PRs (via gh CLI)
 *   GET    /github/prs/:number                         PR detail with comments/files
 */
import type { RouteHandler } from './index.js'
import { isAuthorizedRequest } from './auth.js'
import { SseStream } from './sse-stream.js'
import type { RuntimeSessionManager } from './session-manager.js'
import type { Artifact } from '../artifact/types.js'
import type { SessionRegistry } from '../agent/session-registry.js'
import type { ApprovalMode } from '../agent/loop-types.js'
import type { PlanDocument } from '../plan/plan-store.js'
import type { Config } from '../config/schema.js'
import { computeUsageCost, findModelPricing } from '../utils/pricing.js'
import { getRollbackPreview, rollbackToCheckpoint, makeOwnershipGuard } from '../agent/checkpoint.js'
import { listProjectFiles, rankFiles, listDirEntries } from './file-list.js'
import { listPrs, getPrDetail, isGhAvailable } from './gh-cli.js'
import { resolveAppPromptInput } from '../tui/slash-commands.js'
import { validatePath } from '../tools/path-validate.js'
import { readFileSync, statSync, writeFileSync, mkdirSync } from 'node:fs'
import { extname, relative, join } from 'node:path'
import type { HookEntry, HookEvent, HooksConfig } from '../hooks/user-hooks-runner.js'
import { loadHooksConfig, VALID_EVENTS } from '../hooks/user-hooks-runner.js'

export type ArtifactKind = 'plan' | 'task-list' | 'walkthrough' | 'diff' | 'screenshot' | 'test-result' | 'markdown' | 'html'

/** Vision upload guards — provider-safe formats and a per-image byte ceiling. */
const MAX_IMAGES = 4
/** Per-image decoded byte cap (safety net; the client compresses to ~256KB). */
const MAX_IMAGE_BYTES = 1.5 * 1024 * 1024
const ACCEPTED_IMAGE_DATA_URL = /^data:image\/(png|jpeg|webp|gif);base64,.+$/i

/** Decoded byte size of a `data:...;base64,<payload>` URL (without decoding it). */
function decodedBase64Bytes(dataUrl: string): number {
  const comma = dataUrl.indexOf(',')
  if (comma < 0) return 0
  const b64 = dataUrl.slice(comma + 1)
  const padding = b64.endsWith('==') ? 2 : b64.endsWith('=') ? 1 : 0
  return Math.floor((b64.length * 3) / 4) - padding
}

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
  if (/\.(md|markdown|mdx)$/.test(target) || tool === 'render_markdown') return 'markdown'
  if (/\.(html?)$/.test(target) || tool === 'render_html') return 'html'
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
  config?: Config,
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
      const data = (body ?? {}) as { cwd?: string; title?: string; prompt?: string; approvalMode?: unknown; isolatedWorktree?: unknown }
      if (data.approvalMode !== undefined && !isApprovalMode(data.approvalMode)) {
        return { status: 400, body: { error: 'Invalid "approvalMode"' } }
      }
      const rec = manager.createSession({
        cwd: data.cwd,
        title: data.title,
        prompt: data.prompt,
        approvalMode: data.approvalMode as ApprovalMode | undefined,
        isolatedWorktree: data.isolatedWorktree === true,
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

    // ── PlusMenu: model picker ──
    // Read — selectable models across all providers, current one flagged.
    'GET /sessions/:id/models': withAuth((_body, params) => {
      const models = manager.listModels(params!.id!)
      if (!models) return { status: 404, body: { error: 'Session not found' } }
      return { status: 200, body: { models } }
    }, apiToken),

    // Write — hot-switch the session's model (preserves history). Non-running only.
    'POST /sessions/:id/model': withAuth((body, params) => {
      const data = (body ?? {}) as { modelId?: unknown }
      if (typeof data.modelId !== 'string' || !data.modelId.trim()) {
        return { status: 400, body: { error: 'Missing or invalid "modelId"' } }
      }
      if (!manager.switchModel(params!.id!, data.modelId.trim())) {
        return { status: 409, body: { error: 'Session missing/running or model not found' } }
      }
      return { status: 200, body: manager.getSession(params!.id!) }
    }, apiToken),

    // ── PlusMenu: star-domain picker ──
    // Read — Auto / Off / domains, current selection flagged (shared builder).
    'GET /sessions/:id/domains': withAuth((_body, params) => {
      const entries = manager.listDomains(params!.id!)
      if (!entries) return { status: 404, body: { error: 'Session not found' } }
      return { status: 200, body: { entries } }
    }, apiToken),

    // Write — set the session's star domain by key (auto | off | <domainId>).
    'POST /sessions/:id/domain': withAuth((body, params) => {
      const data = (body ?? {}) as { key?: unknown }
      if (typeof data.key !== 'string' || !data.key.trim()) {
        return { status: 400, body: { error: 'Missing or invalid "key"' } }
      }
      if (!manager.setDomain(params!.id!, data.key.trim())) {
        return { status: 404, body: { error: 'Session not found or unknown domain key' } }
      }
      return { status: 200, body: { id: params!.id!, domain: data.key.trim() } }
    }, apiToken),

    // ── PlusMenu: skills toggle ──
    // Read — every loaded skill with its per-session enablement status.
    'GET /sessions/:id/skills': withAuth((_body, params) => {
      const skills = manager.listSkills(params!.id!)
      if (!skills) return { status: 404, body: { error: 'Session not found' } }
      return { status: 200, body: { skills } }
    }, apiToken),

    // Write — enable/disable a skill for this session (affects discovery block).
    'POST /sessions/:id/skills': withAuth((body, params) => {
      const data = (body ?? {}) as { name?: unknown; enabled?: unknown }
      if (typeof data.name !== 'string' || !data.name.trim()) {
        return { status: 400, body: { error: 'Missing or invalid "name"' } }
      }
      if (typeof data.enabled !== 'boolean') {
        return { status: 400, body: { error: 'Missing or invalid "enabled" (boolean)' } }
      }
      if (!manager.setSkillEnabled(params!.id!, data.name.trim(), data.enabled)) {
        return { status: 404, body: { error: 'Session not found' } }
      }
      return { status: 200, body: { id: params!.id!, name: data.name.trim(), enabled: data.enabled } }
    }, apiToken),

    'GET /sessions': withAuth((_body, params) => {
      const includeArchived = params?.includeArchived === 'true'
      const sessions = includeArchived
        ? manager.listAllSessions()
        : manager.listSessions()
      return { status: 200, body: { sessions } }
    }, apiToken),

    // Archive (soft-close) a session. Aborts if running, marks archived, hides
    // from listSessions. Data survives on disk for potential recovery.
    'DELETE /sessions/:id': withAuth((_body, params) => {
      if (!manager.archiveSession(params!.id!)) {
        return { status: 404, body: { error: 'Session not found or already archived' } }
      }
      return { status: 200, body: { archived: true } }
    }, apiToken),

    // Restore a previously archived session back to the active list.
    'POST /sessions/:id/unarchive': withAuth((_body, params) => {
      if (!manager.unarchiveSession(params!.id!)) {
        return { status: 404, body: { error: 'Session not found or not archived' } }
      }
      return { status: 200, body: { archived: false } }
    }, apiToken),

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
      // Validate images: array of provider-safe base64 data URLs. Defense in
      // depth — the desktop already compresses + transcodes, but the server is
      // the trust boundary (formats the model can't consume, oversized payloads).
      let images: string[] | undefined
      if (data.images !== undefined) {
        if (!Array.isArray(data.images) || data.images.length === 0) {
          return { status: 400, body: { error: '"images" must be a non-empty array' } }
        }
        if (data.images.length > MAX_IMAGES) {
          return { status: 400, body: { error: `Max ${MAX_IMAGES} images allowed` } }
        }
        for (const img of data.images) {
          if (typeof img !== 'string' || !ACCEPTED_IMAGE_DATA_URL.test(img)) {
            return { status: 400, body: { error: 'Each image must be a data:image/(png|jpeg|webp|gif);base64 URL' } }
          }
          if (decodedBase64Bytes(img) > MAX_IMAGE_BYTES) {
            return { status: 400, body: { error: `Each image must be <= ${Math.round(MAX_IMAGE_BYTES / 1024)}KB` } }
          }
        }
        images = data.images as string[]
      }

      // Slash 翻译层（对齐 TUI 端 resolveAppPromptInput 行为）。
      // 桌面 PlusMenu 命令是写死人话经 onSend 发送；自由文本输入若以 "/" 起头，
      // 这里负责把 /plan /team /council /review /write-plan /plan-close 等
      // ecosystem 命令翻译成结构化 prompt，自定义命令也走 .rivet/commands/。
      // 未识别 slash → 4xx 友好提示（与 TUI rejectSubmit 行为对齐，避免凭空丢失消息）。
      let prompt = data.prompt
      const trimmed = prompt.trim()
      if (trimmed.startsWith('/')) {
        const record = manager.getSession(params!.id!)
        if (record) {
          const resolved = resolveAppPromptInput(trimmed, record.cwd)
          if (resolved === null) {
            const first = trimmed.split(/\s+/)[0]
            return {
              status: 400,
              body: { error: `Unknown slash command: "${first}". Type a normal message or use the command menu (+).` },
            }
          }
          prompt = resolved
        }
      }

      const ok = manager.run(params!.id!, prompt, images)
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

    // Insights — aggregated token usage, cost, and per-worker/model/provider
    // breakdowns derived from delegation events. Bearer-gated.
    'GET /sessions/:id/insights': withAuth((_body, params) => {
      const id = params!.id!
      const rec = manager.getSession(id)
      if (!rec) return { status: 404, body: { error: 'Session not found' } }
      const events = manager.getEvents(id, 0)
      if (!events) return { status: 404, body: { error: 'Session not found' } }

      const providers = config?.provider.providers ?? {}
      const workers = new Map<string, {
        workerId: string
        parentId?: string
        profile?: string
        status?: string
        model?: string
        provider?: string
        objective?: string
        elapsedMs?: number
        inputTokens: number
        outputTokens: number
        cacheReadTokens: number
        cacheWriteTokens: number
        reasoningTokens: number
        totalTokens: number
        cost: number
      }>()
      const modelTotals = new Map<string, { model: string; provider?: string; inputTokens: number; outputTokens: number; totalTokens: number; cost: number; count: number }>()
      const providerTotals = new Map<string, { provider: string; inputTokens: number; outputTokens: number; totalTokens: number; cost: number; count: number }>()

      // Main session turn-level usage (turn_complete events).
      let mainInput = 0
      let mainOutput = 0
      let mainCacheRead = 0
      let mainCacheWrite = 0
      let mainReasoning = 0
      const mainModel = rec.model

      for (const ev of events.events) {
        if (ev.type === 'turn_complete') {
          const data = ev.data as { usage?: { input_tokens?: number; output_tokens?: number; cache_read_input_tokens?: number; cache_creation_input_tokens?: number; reasoning_tokens?: number } }
          if (data.usage) {
            mainInput += data.usage.input_tokens ?? 0
            mainOutput += data.usage.output_tokens ?? 0
            mainCacheRead += data.usage.cache_read_input_tokens ?? 0
            mainCacheWrite += data.usage.cache_creation_input_tokens ?? 0
            mainReasoning += data.usage.reasoning_tokens ?? 0
          }
          continue
        }
        if (ev.type !== 'delegation') continue
        const data = ev.data as {
          workerId?: string
          parentId?: string
          profile?: string
          status?: string
          objective?: string
          elapsedMs?: number
          model?: string
          provider?: string
          usage?: {
            input_tokens?: number
            output_tokens?: number
            cache_read_input_tokens?: number
            cache_creation_input_tokens?: number
            reasoning_tokens?: number
            total_tokens?: number
          }
        }
        const workerId = data.workerId
        if (!workerId) continue

        const usage = data.usage
        const model = data.model
        const provider = data.provider
        const pricing = findModelPricing(providers, provider, model)
        const costBreakdown = computeUsageCost(
          usage
            ? {
                input_tokens: usage.input_tokens,
                output_tokens: usage.output_tokens,
                cache_read_input_tokens: usage.cache_read_input_tokens,
                cache_creation_input_tokens: usage.cache_creation_input_tokens,
                reasoning_tokens: usage.reasoning_tokens,
              }
            : undefined,
          pricing,
        )

        const inputTokens = usage?.input_tokens ?? 0
        const outputTokens = usage?.output_tokens ?? 0
        const cacheReadTokens = usage?.cache_read_input_tokens ?? 0
        const cacheWriteTokens = usage?.cache_creation_input_tokens ?? 0
        const reasoningTokens = usage?.reasoning_tokens ?? 0
        const totalTokens = usage?.total_tokens ?? inputTokens + outputTokens

        const existing = workers.get(workerId)
        const worker = {
          workerId,
          parentId: data.parentId ?? existing?.parentId,
          profile: data.profile ?? existing?.profile,
          status: data.status ?? existing?.status,
          model: model ?? existing?.model,
          provider: provider ?? existing?.provider,
          objective: data.objective ?? existing?.objective,
          elapsedMs: data.elapsedMs ?? existing?.elapsedMs,
          inputTokens: (existing?.inputTokens ?? 0) + inputTokens,
          outputTokens: (existing?.outputTokens ?? 0) + outputTokens,
          cacheReadTokens: (existing?.cacheReadTokens ?? 0) + cacheReadTokens,
          cacheWriteTokens: (existing?.cacheWriteTokens ?? 0) + cacheWriteTokens,
          reasoningTokens: (existing?.reasoningTokens ?? 0) + reasoningTokens,
          totalTokens: (existing?.totalTokens ?? 0) + totalTokens,
          cost: (existing?.cost ?? 0) + costBreakdown.total,
        }
        workers.set(workerId, worker)

        if (model) {
          const mt = modelTotals.get(model) ?? { model, provider, inputTokens: 0, outputTokens: 0, totalTokens: 0, cost: 0, count: 0 }
          mt.inputTokens += inputTokens
          mt.outputTokens += outputTokens
          mt.totalTokens += totalTokens
          mt.cost += costBreakdown.total
          mt.count += 1
          if (provider && !mt.provider) mt.provider = provider
          modelTotals.set(model, mt)
        }
        if (provider) {
          const pt = providerTotals.get(provider) ?? { provider, inputTokens: 0, outputTokens: 0, totalTokens: 0, cost: 0, count: 0 }
          pt.inputTokens += inputTokens
          pt.outputTokens += outputTokens
          pt.totalTokens += totalTokens
          pt.cost += costBreakdown.total
          pt.count += 1
          providerTotals.set(provider, pt)
        }
      }

      const workerList = [...workers.values()]
      const workerInput = workerList.reduce((sum, w) => sum + w.inputTokens, 0)
      const workerOutput = workerList.reduce((sum, w) => sum + w.outputTokens, 0)
      const workerCacheRead = workerList.reduce((sum, w) => sum + w.cacheReadTokens, 0)
      const workerCacheWrite = workerList.reduce((sum, w) => sum + w.cacheWriteTokens, 0)
      const workerReasoning = workerList.reduce((sum, w) => sum + w.reasoningTokens, 0)
      const workerTotalTokens = workerList.reduce((sum, w) => sum + w.totalTokens, 0)
      const workerCost = workerList.reduce((sum, w) => sum + w.cost, 0)

      // Main session cost — resolve provider from model id, compute USD cost.
      const mainTotalTokens = mainInput + mainOutput
      const mainProvider = mainModel
        ? Object.entries(providers).find(([, p]) =>
            p.models?.some(m => m.id === mainModel || m.alias === mainModel),
          )?.[0]
        : undefined
      const mainPricing = findModelPricing(providers, mainProvider, mainModel)
      const mainCostBreakdown = computeUsageCost(
        mainTotalTokens > 0
          ? {
              input_tokens: mainInput,
              output_tokens: mainOutput,
              cache_read_input_tokens: mainCacheRead,
              cache_creation_input_tokens: mainCacheWrite,
              reasoning_tokens: mainReasoning,
            }
          : undefined,
        mainPricing,
      )

      const mainSession = mainTotalTokens > 0 ? {
        inputTokens: mainInput,
        outputTokens: mainOutput,
        cacheReadTokens: mainCacheRead,
        cacheWriteTokens: mainCacheWrite,
        reasoningTokens: mainReasoning,
        totalTokens: mainTotalTokens,
        model: mainModel,
        provider: mainProvider,
        cost: mainCostBreakdown.total,
      } : null

      const totalCacheRead = workerCacheRead + (mainSession?.cacheReadTokens ?? 0)
      const totalCacheWrite = workerCacheWrite + (mainSession?.cacheWriteTokens ?? 0)
      const cacheHitRate = totalCacheRead + totalCacheWrite > 0
        ? Math.round((totalCacheRead / (totalCacheRead + totalCacheWrite)) * 100)
        : null

      return {
        status: 200,
        body: {
          totals: {
            workers: workers.size,
            inputTokens: workerInput + (mainSession?.inputTokens ?? 0),
            outputTokens: workerOutput + (mainSession?.outputTokens ?? 0),
            cacheReadTokens: totalCacheRead,
            cacheWriteTokens: totalCacheWrite,
            reasoningTokens: workerReasoning + (mainSession?.reasoningTokens ?? 0),
            totalTokens: workerTotalTokens + (mainSession?.totalTokens ?? 0),
            cost: workerCost + (mainSession?.cost ?? 0),
          },
          cacheHitRate,
          mainSession,
          workers: workerList,
          modelBreakdown: [...modelTotals.values()],
          providerBreakdown: [...providerTotals.values()],
        },
      }
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

    // P2-2 — file content viewer. Reads a file within the session cwd, returns
    // content + language hint. Path is sandboxed via validatePath. Optional
    // ?start=1&end=50 line range to avoid transferring huge files. Bearer-gated.
    'GET /sessions/:id/file-content': withAuth(async (_body, params) => {
      const rec = manager.getSession(params!.id!)
      if (!rec) return { status: 404, body: { error: 'Session not found' } }
      const relPath = typeof params?.path === 'string' ? params.path : ''
      if (!relPath) return { status: 400, body: { error: 'Missing "path" query param' } }

      let absPath: string
      try {
        absPath = validatePath(rec.cwd, relPath, 'read')
      } catch {
        return { status: 403, body: { error: 'Path outside session cwd' } }
      }

      let stat
      try {
        stat = statSync(absPath)
      } catch {
        return { status: 404, body: { error: 'File not found' } }
      }
      if (!stat.isFile()) return { status: 400, body: { error: 'Not a file' } }
      // Cap at 512KB to avoid sending huge files over IPC
      if (stat.size > 512 * 1024) return { status: 413, body: { error: 'File too large (>512KB)' } }

      const content = readFileSync(absPath, 'utf-8')
      const lines = content.split('\n')
      const start = Math.max(1, Number(params?.start) || 1)
      const end = Math.min(lines.length, Number(params?.end) || lines.length)
      const sliced = lines.slice(start - 1, end).join('\n')

      const ext = extname(absPath).slice(1).toLowerCase()
      const LANGUAGE_MAP: Record<string, string> = {
        ts: 'typescript', tsx: 'typescript', js: 'javascript', jsx: 'javascript',
        py: 'python', rs: 'rust', go: 'go', rb: 'ruby', java: 'java',
        css: 'css', scss: 'scss', json: 'json', md: 'markdown', yml: 'yaml',
        yaml: 'yaml', sh: 'bash', bash: 'bash', sql: 'sql', html: 'html', xml: 'xml',
      }

      return {
        status: 200,
        body: {
          path: relative(rec.cwd, absPath),
          content: sliced,
          language: LANGUAGE_MAP[ext] ?? 'plaintext',
          totalLines: lines.length,
          startLine: start,
          endLine: end,
        },
      }
    }, apiToken),

    // Gap 1 — directory listing for the read-only file browser. Returns direct
    // children of a sub-directory within cwd (one level, not recursive).
    // ?path=src/components (empty/omitted = cwd root). Bearer-gated.
    'GET /sessions/:id/list-dir': withAuth(async (_body, params) => {
      const rec = manager.getSession(params!.id!)
      if (!rec) return { status: 404, body: { error: 'Session not found' } }
      const relPath = typeof params?.path === 'string' ? params.path : ''
      let absDir: string
      try {
        absDir = relPath ? validatePath(rec.cwd, relPath, 'read') : rec.cwd
      } catch {
        return { status: 403, body: { error: 'Path outside session cwd' } }
      }
      const entries = await listDirEntries(absDir)
      return { status: 200, body: { path: relPath, entries } }
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
      const data = (body ?? {}) as {
        artifactId?: string
        comment?: string
        lines?: Array<{ file: string; oldLine?: number; newLine?: number; comment: string }>
      }
      const hasComment = data.comment && data.comment.trim()
      const hasLines = data.lines && data.lines.some((l) => l.comment && l.comment.trim())
      if (!data.artifactId || (!hasComment && !hasLines)) {
        return { status: 400, body: { error: 'Missing "artifactId", or both "comment" and "lines" are empty' } }
      }
      const ok = manager.feedback(
        params!.id!,
        data.artifactId,
        (data.comment ?? '').trim(),
        data.lines,
      )
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

    // I1 — convene a star-domain council on a plan artifact.
    // Body: { artifactId: string, objective?: string, seats?: [...], rounds?: 1|2 }
    'POST /sessions/:id/council': withAuth(async (body, params) => {
      const data = (body ?? {}) as { artifactId?: unknown; objective?: unknown; seats?: unknown; rounds?: unknown }
      if (typeof data.artifactId !== 'string' || !data.artifactId.trim()) {
        return { status: 400, body: { error: 'Missing or invalid "artifactId"' } }
      }
      if (data.objective !== undefined && typeof data.objective !== 'string') {
        return { status: 400, body: { error: 'Invalid "objective"' } }
      }
      if (data.seats !== undefined && (!Array.isArray(data.seats) || data.seats.some((s: unknown) => !s || typeof (s as { authority?: unknown }).authority !== 'string'))) {
        return { status: 400, body: { error: 'Invalid "seats"' } }
      }
      if (data.rounds !== undefined && (typeof data.rounds !== 'number' || data.rounds < 1 || data.rounds > 2)) {
        return { status: 400, body: { error: 'Invalid "rounds" (must be 1 or 2)' } }
      }
      const session = manager.getSession(params!.id!)
      if (!session) return { status: 404, body: { error: 'Session not found' } }
      // I1: ensure the session has a live agent. The agent is lazily built on
      // first run; council must operate on a ready agent (idle is OK as long as
      // the agent exists and is not currently running a turn).
      const agent = manager.getAgentForSession?.(params!.id!)
      if (!agent || typeof agent.conveneCouncil !== 'function') {
        return { status: 503, body: { error: 'Agent not ready' } }
      }
      try {
        const result = await agent.conveneCouncil({
          artifactId: data.artifactId.trim(),
          ...(data.objective ? { objective: data.objective } : {}),
          ...(data.seats ? { seats: data.seats as { authority: string; charter?: string }[] } : {}),
          ...(typeof data.rounds === 'number' ? { rounds: data.rounds } : {}),
        })
        return { status: 200, body: result }
      } catch (err: unknown) {
        if (err instanceof Error && 'statusCode' in err && typeof (err as { statusCode: unknown }).statusCode === 'number') {
          return { status: (err as { statusCode: number }).statusCode, body: { error: err.message } }
        }
        return { status: 500, body: { error: (err as Error)?.message ?? 'Council failed' } }
      }
    }, apiToken),

    // I4 — read user-defined .rivet/hooks.json for this session.
    'GET /sessions/:id/hooks': withAuth((_body, params) => {
      const rec = manager.getSession(params!.id!)
      if (!rec) return { status: 404, body: { error: 'Session not found' } }
      const config = loadHooksConfig(rec.cwd)
      return { status: 200, body: config }
    }, apiToken),

    // I4 — write user-defined .rivet/hooks.json for this session.
    'PUT /sessions/:id/hooks': withAuth((body, params) => {
      const rec = manager.getSession(params!.id!)
      if (!rec) return { status: 404, body: { error: 'Session not found' } }
      const data = (body ?? {}) as { hooks?: unknown }
      if (!Array.isArray(data.hooks)) {
        return { status: 400, body: { error: 'Missing or invalid "hooks" array' } }
      }
      const hooks: HookEntry[] = []
      for (const entry of data.hooks) {
        if (!entry || typeof entry !== 'object') {
          return { status: 400, body: { error: 'Each hook must be an object' } }
        }
        const e = entry as Record<string, unknown>
        if (!VALID_EVENTS.has(e.event as HookEvent)) {
          return { status: 400, body: { error: `Invalid hook event "${e.event}"` } }
        }
        if (typeof e.script !== 'string' || !e.script.trim()) {
          return { status: 400, body: { error: 'Each hook must have a non-empty "script"' } }
        }
        const timeoutMs = typeof e.timeoutMs === 'number' ? e.timeoutMs : undefined
        hooks.push({ event: e.event as HookEvent, script: e.script.trim(), ...(timeoutMs !== undefined ? { timeoutMs } : {}) })
      }
      const dir = join(rec.cwd, '.rivet')
      const path = join(dir, 'hooks.json')
      try {
        validatePath(rec.cwd, path, 'write')
      } catch {
        return { status: 400, body: { error: 'Invalid hooks path' } }
      }
      mkdirSync(dir, { recursive: true })
      writeFileSync(path, JSON.stringify({ hooks }, null, 2), 'utf-8')
      return { status: 200, body: { hooks } }
    }, apiToken),

    // Vision — serve a persisted user-attached image by id. The desktop fetches
    // this with the Bearer header (img src cannot carry headers, so the client
    // turns the bytes into a blob object URL). Binary response: take over `res`.
    'GET /sessions/:id/images/:imgId': withAuth((_body, params, _headers, res) => {
      if (!res) return { status: 500, body: { error: 'Response stream is unavailable' } }
      const img = manager.readImage(params!.id!, params!.imgId!)
      if (!img) return { status: 404, body: { error: 'Image not found' } }
      res.writeHead(200, {
        'Content-Type': img.mime,
        'Content-Length': img.bytes.length,
        'Cache-Control': 'private, max-age=31536000, immutable',
        'Access-Control-Allow-Origin': '*',
      })
      res.end(img.bytes)
      return { status: 200, handled: true }
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

    // Git worktrees — list all worktrees for the repo root (used by the desktop
    // sidebar to show worktree branch status for sessions).
    'GET /worktrees': withAuth(() => ({
      status: 200,
      body: { worktrees: manager.getWorktrees() },
    }), apiToken),

    // Git branch graph — ASCII graph for the repo root.
    'GET /git/graph': withAuth(async (_body, params) => {
      const maxCount = params?.maxCount ? Number(params.maxCount) : undefined
      const graph = await manager.getGitGraph(undefined, maxCount)
      return { status: 200, body: { graph: graph.split('\n') } }
    }, apiToken),

    // Working-tree changes relative to HEAD (file list only; per-file diff fetched on demand).
    // Used by the desktop "changes" tab — lightweight file list, no diff body.
    'GET /git/working-tree': withAuth(async () => {
      const result = await manager.getWorkingTreeFiles()
      return { status: 200, body: result }
    }, apiToken),

    // Unified diff of a single file relative to HEAD (on-demand, for the changes tab).
    'GET /git/diff': withAuth(async (_body, params) => {
      const path = params?.path
      if (!path || typeof path !== 'string') return { status: 400, body: { error: 'Missing path param' } }
      const diff = await manager.getFileDiff(path)
      return { status: 200, body: { diff } }
    }, apiToken),

    // GitHub PR integration — list open PRs for the repo. Requires `gh` CLI.
    'GET /github/prs': withAuth(async () => {
      const cwd = manager.getDefaultCwd()
      const available = await isGhAvailable(cwd)
      if (!available) return { status: 200, body: { prs: [], ghAvailable: false } }
      const prs = await listPrs(cwd)
      return { status: 200, body: { prs: prs ?? [], ghAvailable: true } }
    }, apiToken),

    // GitHub PR detail — get a single PR with comments and changed files.
    'GET /github/prs/:number': withAuth(async (_body, params) => {
      const cwd = manager.getDefaultCwd()
      const num = Number(params?.number)
      if (!num || num <= 0) return { status: 400, body: { error: 'Invalid PR number' } }
      const pr = await getPrDetail(cwd, num)
      if (!pr) return { status: 404, body: { error: 'PR not found or gh not available' } }
      return { status: 200, body: pr }
    }, apiToken),
  }

  return routes
}
