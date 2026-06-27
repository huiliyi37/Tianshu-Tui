import { invoke } from '@tauri-apps/api/core'
import type {
  ApprovalDecision,
  ApprovalMode,
  ArtifactSummary,
  DomainEntry,
  FileContent,
  GitGraphResponse,
  HealthInfo,
  InsightsResponse,
  ModelEntry,
  PlanDoc,
  PlanModeState,
  PlanSummary,
  ScheduledTask,
  SessionEvent,
  SessionRecord,
  SkillStatus,
} from './types'

export interface RuntimeInfo {
  port: number
  token: string
}

let cached: RuntimeInfo | null = null

// Node-safe env access: `import.meta.env` only exists under Vite; reading it in
// a node:test context (where this module is unit-tested) would throw.
function viteEnv(): Record<string, string | undefined> {
  return ((import.meta as unknown as { env?: Record<string, string | undefined> }).env) ?? {}
}

/**
 * The Rust shell spawns `rivet serve` as a sidecar, generates a random
 * RIVET_SERVER_TOKEN, and exposes the live port + token via the `runtime_info`
 * Tauri command. In a plain browser dev context (no Tauri), fall back to env so
 * the UI can be developed against a manually-started `rivet serve`.
 */
export async function getRuntimeInfo(): Promise<RuntimeInfo> {
  if (cached) return cached
  try {
    cached = await invoke<RuntimeInfo>('runtime_info')
  } catch {
    const env = viteEnv()
    const port = Number(env.VITE_RIVET_PORT ?? 3100)
    const token = String(env.VITE_RIVET_TOKEN ?? '')
    cached = { port, token }
  }
  return cached
}

/**
 * Drop the memoized port/token. The sidecar can restart (crash recovery, a new
 * `rivet serve` after a `tauri dev` reload) with a fresh random token+port; a
 * permanently-cached value would then send a stale token to a dead port and
 * every request would 401 / ECONNREFUSED forever ("reconnect deadlock"). We
 * clear on the two signals of a stale handle — a 401 (token rotated) and a
 * network throw (port gone) — so the next call re-invokes `runtime_info`.
 */
export function clearRuntimeCache(): void {
  cached = null
}

/** Test-only: inspect the memoized runtime handle (null when cleared). */
export function __peekRuntimeCache(): RuntimeInfo | null {
  return cached
}

export function runtimeBaseUrl(info: RuntimeInfo): string {
  return `http://127.0.0.1:${info.port}`
}

/**
 * Low-level authed fetch against the sidecar. Shared by the REST helpers below
 * and the SSE stream reader (runtime/sse.ts) so the Bearer token lives in one
 * place. Throws on non-2xx (callers in this file check `res.ok`).
 */
export async function rivetFetch(path: string, init: RequestInit = {}): Promise<Response> {
  const info = await getRuntimeInfo()
  const headers = new Headers(init.headers)
  headers.set('Authorization', `Bearer ${info.token}`)
  if (init.body && !headers.has('Content-Type')) headers.set('Content-Type', 'application/json')
  let res: Response
  try {
    res = await fetch(runtimeBaseUrl(info) + path, { ...init, headers })
  } catch (err) {
    // Port gone (sidecar down/restarted) — invalidate so the next call
    // re-resolves a fresh handle instead of retrying the dead one.
    clearRuntimeCache()
    throw err
  }
  // Token rotated after a sidecar restart — drop the stale handle; the caller's
  // next attempt re-invokes runtime_info and picks up the new token.
  if (res.status === 401) clearRuntimeCache()
  return res
}

async function apiGet<T>(path: string): Promise<T> {
  const res = await rivetFetch(path)
  if (!res.ok) throw new Error(`GET ${path} -> ${res.status}`)
  return res.json() as Promise<T>
}

async function apiPost<T>(path: string, body?: unknown): Promise<T> {
  const res = await rivetFetch(path, { method: 'POST', body: body ? JSON.stringify(body) : undefined })
  if (!res.ok) throw new Error(`POST ${path} -> ${res.status}`)
  return res.json() as Promise<T>
}

// ── Health (N1) ─────────────────────────────────────────────────────

export function getHealth(): Promise<HealthInfo> {
  return apiGet<HealthInfo>('/health')
}

// ── Session API ─────────────────────────────────────────────────────

export function createSession(input: {
  cwd?: string
  title?: string
  prompt?: string
  approvalMode?: ApprovalMode
  isolatedWorktree?: boolean
}): Promise<SessionRecord> {
  return apiPost<SessionRecord>('/sessions', input)
}

/** S — switch a session's autonomy level (监督/默认/自治). Live on a running agent. */
export function setApprovalMode(id: string, approvalMode: ApprovalMode): Promise<{ id: string; approvalMode: ApprovalMode }> {
  return apiPost<{ id: string; approvalMode: ApprovalMode }>(`/sessions/${id}/approval-mode`, { approvalMode })
}

export async function listSessions(): Promise<SessionRecord[]> {
  const { sessions } = await apiGet<{ sessions: SessionRecord[] }>('/sessions')
  return sessions
}

export async function openFile(path: string): Promise<void> {
  await apiPost('/open-file', { path })
}

export async function listAllSessions(): Promise<SessionRecord[]> {
  const { sessions } = await apiGet<{ sessions: SessionRecord[] }>('/sessions?includeArchived=true')
  return sessions
}

export function getSession(id: string): Promise<SessionRecord> {
  return apiGet<SessionRecord>(`/sessions/${id}`)
}

export function sendPrompt(id: string, prompt: string, images?: string[]): Promise<SessionRecord> {
  return apiPost<SessionRecord>(`/sessions/${id}/prompt`, { prompt, ...(images?.length ? { images } : {}) })
}

/**
 * Fetch a server-persisted user image and return a blob object URL. The image
 * route is Bearer-gated (an `<img src>` cannot carry the header), so we fetch
 * the bytes with auth and hand back an object URL. Callers MUST revoke it via
 * URL.revokeObjectURL when the image unmounts to avoid a memory leak.
 */
export async function fetchSessionImageObjectUrl(id: string, imgId: string): Promise<string> {
  const res = await rivetFetch(`/sessions/${id}/images/${imgId}`)
  if (!res.ok) throw new Error(`GET /sessions/${id}/images/${imgId} -> ${res.status}`)
  const blob = await res.blob()
  return URL.createObjectURL(blob)
}

/**
 * T3 — queue mid-run guidance into a running session. Does not start a turn.
 * Returns 'queued' on success, 'idle' if the session isn't running (caller
 * should fall back to sendPrompt). Does not throw on the 409 idle case.
 */
export async function steerSession(id: string, text: string): Promise<'queued' | 'idle'> {
  const res = await rivetFetch(`/sessions/${id}/steer`, {
    method: 'POST',
    body: JSON.stringify({ text }),
  })
  if (res.status === 409) return 'idle'
  if (!res.ok) throw new Error(`POST /sessions/${id}/steer -> ${res.status}`)
  return 'queued'
}

/** N2 — feedback on an artifact, re-injected as next-turn context. */
export function sendArtifactFeedback(id: string, artifactId: string, comment: string): Promise<SessionRecord> {
  return apiPost<SessionRecord>(`/sessions/${id}/feedback`, { artifactId, comment })
}

export function abortSession(id: string): Promise<{ aborted: boolean }> {
  return apiPost<{ aborted: boolean }>(`/sessions/${id}/abort`)
}

/** Archive (soft-close) a session — hides it from the sidebar list. Data survives on disk. */
export async function closeSession(id: string): Promise<{ archived: boolean }> {
  const res = await rivetFetch(`/sessions/${id}`, { method: 'DELETE' })
  if (!res.ok) throw new Error(`DELETE /sessions/${id} -> ${res.status}`)
  return res.json() as Promise<{ archived: boolean }>
}

/** Restore a previously archived session back to the active list. */
export async function unarchiveSession(id: string): Promise<{ archived: boolean }> {
  return apiPost<{ archived: boolean }>(`/sessions/${id}/unarchive`)
}

export function fetchEvents(id: string, since: number): Promise<{ events: SessionEvent[]; lastSeq: number }> {
  return apiGet<{ events: SessionEvent[]; lastSeq: number }>(`/sessions/${id}/events?since=${since}`)
}

/** Insights — aggregated token usage, cost, and per-worker/model/provider breakdowns. */
export function getInsights(id: string): Promise<InsightsResponse> {
  return apiGet<InsightsResponse>(`/sessions/${id}/insights`)
}

/** D2 — @file mention picker: ranked project files under the session cwd. */
export async function listFiles(id: string, query: string, limit = 50): Promise<string[]> {
  const qs = `q=${encodeURIComponent(query)}&limit=${limit}`
  const { files } = await apiGet<{ files: string[] }>(`/sessions/${id}/files?${qs}`)
  return files
}

/** P2-2 — file content viewer: read a file within the session cwd. */
export async function getFileContent(
  id: string,
  path: string,
  range?: { start?: number; end?: number },
): Promise<FileContent> {
  const qs = new URLSearchParams({ path })
  if (range?.start) qs.set('start', String(range.start))
  if (range?.end) qs.set('end', String(range.end))
  return apiGet<FileContent>(`/sessions/${id}/file-content?${qs}`)
}

export function answerApproval(
  id: string,
  requestId: string,
  decision: ApprovalDecision,
  editedInput?: Record<string, unknown>,
): Promise<{ ok: boolean }> {
  return apiPost<{ ok: boolean }>(`/sessions/${id}/interventions/${requestId}/answer`, {
    decision,
    ...(editedInput ? { editedInput } : {}),
  })
}

/** N2 — resolve an intent-preview intervention. */
export function answerIntent(
  id: string,
  requestId: string,
  decision: 'continue' | 'veto' | 'alternative',
): Promise<{ ok: boolean }> {
  return apiPost<{ ok: boolean }>(`/sessions/${id}/interventions/${requestId}/answer`, { decision })
}

// ── PlusMenu: models / star-domains / skills ────────────────────────

/** List selectable models for a session (current one flagged). */
export async function listModels(id: string): Promise<ModelEntry[]> {
  const { models } = await apiGet<{ models: ModelEntry[] }>(`/sessions/${id}/models`)
  return models
}

/** Hot-switch a session's model (preserves history). Returns the updated record. */
export function switchModel(id: string, modelId: string): Promise<SessionRecord> {
  return apiPost<SessionRecord>(`/sessions/${id}/model`, { modelId })
}

/** List the star-domain picker entries (Auto / Off / domains, current flagged). */
export async function listDomains(id: string): Promise<DomainEntry[]> {
  const { entries } = await apiGet<{ entries: DomainEntry[] }>(`/sessions/${id}/domains`)
  return entries
}

/** Set a session's star domain by key ('auto' | 'off' | <domainId>). */
export function setDomain(id: string, key: string): Promise<{ id: string; domain: string }> {
  return apiPost<{ id: string; domain: string }>(`/sessions/${id}/domain`, { key })
}

/** List every loaded skill with its per-session enablement status. */
export async function listSkills(id: string): Promise<SkillStatus[]> {
  const { skills } = await apiGet<{ skills: SkillStatus[] }>(`/sessions/${id}/skills`)
  return skills
}

/** Enable/disable a skill for a session (affects the discovery block). */
export function setSkillEnabled(
  id: string,
  name: string,
  enabled: boolean,
): Promise<{ id: string; name: string; enabled: boolean }> {
  return apiPost<{ id: string; name: string; enabled: boolean }>(`/sessions/${id}/skills`, { name, enabled })
}

// ── Plan mode ───────────────────────────────────────────────────────

/** Toggle the session into read-only planning ('planning') or execution ('off'). */
export function setPlanMode(id: string, state: PlanModeState): Promise<{ id: string; planMode: PlanModeState }> {
  return apiPost<{ id: string; planMode: PlanModeState }>(`/sessions/${id}/plan-mode`, { state })
}

/** List this session's plans (newest first). */
export async function listPlans(id: string): Promise<PlanSummary[]> {
  const { plans } = await apiGet<{ plans: PlanSummary[] }>(`/sessions/${id}/plans`)
  return plans
}

/** Read a single plan's full markdown content. */
export async function getPlan(id: string, slug: string): Promise<PlanDoc> {
  const { plan } = await apiGet<{ plan: PlanDoc }>(`/sessions/${id}/plans/${encodeURIComponent(slug)}`)
  return plan
}

/** Build — approve a plan and start executing it. */
export function approvePlan(id: string, slug: string): Promise<{ ok: boolean }> {
  return apiPost<{ ok: boolean }>(`/sessions/${id}/plans/${encodeURIComponent(slug)}/approve`)
}

/** Reject a plan with optional revision feedback. */
export function rejectPlan(id: string, slug: string, comment?: string): Promise<{ ok: boolean }> {
  return apiPost<{ ok: boolean }>(`/sessions/${id}/plans/${encodeURIComponent(slug)}/reject`, comment ? { comment } : undefined)
}

// ── Rollback (R3) ───────────────────────────────────────────────────

// ── Rewind (Wave 3) ─────────────────────────────────────────────────

export interface RewindPoint {
  index: number
  content: string
  timestamp: number
}

export function getRewindPoints(id: string): Promise<{ points: RewindPoint[] }> {
  return apiGet<{ points: RewindPoint[] }>(`/sessions/${id}/rewind-points`)
}

export function rewindSession(id: string, messageIndex: number, rollbackFiles?: boolean): Promise<SessionRecord> {
  return apiPost<SessionRecord>(`/sessions/${id}/rewind`, { messageIndex, rollbackFiles })
}

// ── Rollback (R3) ───────────────────────────────────────────────────

export interface RollbackPreview {
  available: boolean
  /** Human-readable preview incl. ⚠️ irreversible bash side-effect caveats. */
  text?: string
  confirmationToken?: string
}

export interface RollbackResult {
  success: boolean
  hash?: string
  /** Files skipped because a different live session owns them. */
  skipped?: string[]
  /** Bash side effects file rollback CANNOT undo (API calls, publishes, …). */
  unrevertable?: string[]
  error?: string
}

export function getRollbackPreview(id: string): Promise<RollbackPreview> {
  return apiGet<RollbackPreview>(`/sessions/${id}/rollback/preview`)
}

/**
 * Execute a rollback. Reads the body on both success (200) and conflict (409)
 * so the caller can surface skipped/unrevertable detail either way.
 */
export async function rollbackSession(id: string, confirmationToken: string): Promise<RollbackResult> {
  const res = await rivetFetch(`/sessions/${id}/rollback`, {
    method: 'POST',
    body: JSON.stringify({ confirmationToken }),
  })
  const json = (await res.json().catch(() => ({}))) as Partial<RollbackResult>
  return {
    success: json.success ?? false,
    hash: json.hash,
    skipped: json.skipped,
    unrevertable: json.unrevertable,
    error: json.error,
  }
}

// ── Artifacts ───────────────────────────────────────────────────────

export async function listArtifacts(id: string): Promise<ArtifactSummary[]> {
  const { artifacts } = await apiGet<{ artifacts: ArtifactSummary[] }>(`/sessions/${id}/artifacts`)
  return artifacts
}

export function getArtifact(id: string, artifactId: string): Promise<{ artifact: ArtifactSummary; raw: string }> {
  return apiGet<{ artifact: ArtifactSummary; raw: string }>(
    `/sessions/${id}/artifacts/${encodeURIComponent(artifactId)}`,
  )
}

// ── Schedule (N3) ───────────────────────────────────────────────────

export async function listSchedule(): Promise<ScheduledTask[]> {
  const { tasks } = await apiGet<{ tasks: ScheduledTask[] }>('/schedule')
  return tasks
}

export function createSchedule(input: {
  prompt: string
  trigger: { type: 'interval' | 'cron' | 'oneshot'; spec: string }
  allowedTools?: string[]
}): Promise<ScheduledTask> {
  return apiPost<ScheduledTask>('/schedule', input)
}

export function pauseSchedule(id: string, enabled: boolean): Promise<{ id: string; enabled: boolean }> {
  return apiPost<{ id: string; enabled: boolean }>(`/schedule/${id}/pause`, { enabled })
}

export async function deleteSchedule(id: string): Promise<void> {
  const res = await rivetFetch(`/schedule/${id}`, { method: 'DELETE' })
  if (!res.ok) throw new Error(`DELETE /schedule/${id} -> ${res.status}`)
}

// ── GitHub PR Integration ───────────────────────────────────────────

export interface PrSummary {
  number: number
  title: string
  state: string
  url: string
  headRefName: string
  author: string
  createdAt: string
  updatedAt: string
  additions: number
  deletions: number
  reviewDecision: string
  isDraft: boolean
}

export interface PrDetail extends PrSummary {
  body: string
  comments: { author: string; body: string; createdAt: string; path?: string; line?: number }[]
  files: { path: string; additions: number; deletions: number; status: string }[]
}

export async function listGithubPrs(): Promise<{ prs: PrSummary[]; ghAvailable: boolean }> {
  return apiGet<{ prs: PrSummary[]; ghAvailable: boolean }>('/github/prs')
}

export async function getGithubPr(number: number): Promise<PrDetail> {
  return apiGet<PrDetail>(`/github/prs/${number}`)
}

// ── Config: Provider Management ─────────────────────────────────────

export interface ProviderListItem {
  name: string
  label: string
  baseUrl: string
  isDefault: boolean
  keyStatus: { source: 'inline' | 'env' | 'none'; ref: string }
  models: { id: string; alias?: string }[]
  isPreset: boolean
}

export interface UnconfiguredPreset {
  key: string
  label: string
  defaultModelId: string
}

export async function listConfigProviders(): Promise<{
  providers: ProviderListItem[]
  unconfigured: UnconfiguredPreset[]
}> {
  return apiGet('/config/providers')
}

export function setupConfigProvider(input: {
  providerName: string
  apiKey?: string
  apiKeyEnv?: string
  baseUrl?: string
  makeDefault?: boolean
}): Promise<{ ok: boolean; providerName: string }> {
  return apiPost('/config/providers', input)
}

export function removeConfigProvider(name: string): Promise<{ ok: boolean }> {
  return rivetFetch(`/config/providers/${name}`, { method: 'DELETE' })
    .then(r => r.json() as Promise<{ ok: boolean }>)
}

export function setProviderKey(
  name: string,
  key: { apiKey?: string; apiKeyEnv?: string },
): Promise<{ ok: boolean; keyStatus: ProviderListItem['keyStatus'] }> {
  return apiPost(`/config/providers/${name}/key`, key)
}

export function setProviderAsDefault(name: string): Promise<{ ok: boolean }> {
  return apiPost(`/config/providers/${name}/default`, {})
}

// ── MCP (Model Context Protocol) ────────────────────────────────────

import type { McpStatusResponse, McpServerConfig, McpServerToolsResponse } from './types'

export async function getMcpStatus(): Promise<McpStatusResponse> {
  return apiGet<McpStatusResponse>('/mcp/status')
}

export function addMcpServer(input: McpServerConfig): Promise<{ ok: boolean; serverId: string }> {
  return apiPost<{ ok: boolean; serverId: string }>('/mcp/servers', input)
}

export async function removeMcpServer(serverId: string): Promise<{ ok: boolean }> {
  const res = await rivetFetch(`/mcp/servers/${encodeURIComponent(serverId)}`, { method: 'DELETE' })
  if (!res.ok) throw new Error(`DELETE /mcp/servers/${serverId} -> ${res.status}`)
  return res.json() as Promise<{ ok: boolean }>
}

export async function restartMcpServer(serverId: string): Promise<{ ok: boolean }> {
  return apiPost<{ ok: boolean }>(`/mcp/servers/${encodeURIComponent(serverId)}/restart`)
}

export async function listMcpServerTools(serverId: string): Promise<McpServerToolsResponse> {
  return apiGet<McpServerToolsResponse>(`/mcp/servers/${encodeURIComponent(serverId)}/tools`)
}

// ── Git graph ───────────────────────────────────────────────────────

export function getGitGraph(maxCount?: number): Promise<GitGraphResponse> {
  const qs = maxCount !== undefined ? `?maxCount=${maxCount}` : ''
  return apiGet<GitGraphResponse>(`/git/graph${qs}`)
}
