import { invoke } from '@tauri-apps/api/core'
import type {
  ApprovalDecision,
  ApprovalMode,
  ArtifactSummary,
  JobState,
  DomainEntry,
  EnvironmentInfo,
  FileContent,
  GitGraphResponse,
  HealthInfo,
  HookEntry,
  HooksConfig,
  InsightsResponse,
  ModelEntry,
  PlanDoc,
  PlanModeState,
  PlanListResponse,
  ProjectDocs,
  ProjectTemplatesApplyResult,
  ProjectTemplatesStatus,
  ScheduledTask,
  TaskRecord,
  SessionEvent,
  SessionRecord,
  SkillStatus,
  SkillsResponse,
  InstallableSkillsResponse,
  SkillInstallResult,
  StorageApplyResult,
  StorageOptions,
  WorkingTreeResponse,
} from './types'
import { perfRecord } from '../state/perf-budget'

export interface RuntimeInfo {
  port: number
  token: string
  /** Which Node hosts the sidecar: 'bundled' (shipped binary) | 'env' | 'system'.
   *  Reported by the Rust shell (runtime_info); absent in the browser-dev fallback. */
  nodeSource?: string
  /** False when the sidecar failed to spawn or never passed /health before launch
   *  — the port/token point at nothing, so the UI shows a fatal "failed to start"
   *  state instead of an endless transient-reconnect banner. Absent (treated as
   *  ready) in the browser-dev fallback and on older shells. */
  ready?: boolean
  /** Resolved RIVET_HOME passed to the sidecar. Reported by the Rust shell. */
  rivetHome?: string
  /** Absolute path to the Node binary used to spawn the sidecar. */
  nodePath?: string
  /** Absolute path to the rivet runtime entry point (`main.js`). */
  entryPath?: string
  /** When `ready` is false because spawn failed, the OS error message. */
  spawnError?: string
  /** Absolute path to the sidecar stdout/stderr log file. */
  logPath?: string
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
  } catch (err) {
    // In a plain browser dev context (no Tauri) this is expected; in the Tauri
    // desktop app it usually means the shell is not ready yet. Don't cache the
    // fallback so the next API call retries the real runtime_info instead of
    // getting stuck on the browser-dev default port 3100.
    if (typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window) {
      console.warn('[rivet] runtime_info invoke failed, using dev fallback:', err)
    }
    const env = viteEnv()
    const port = Number(env.VITE_RIVET_PORT ?? 3100)
    const token = String(env.VITE_RIVET_TOKEN ?? '')
    return { port, token }
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

/** True once the user has chosen a data-root via First-run storage dialog. */
export function isStorageConfigured(): Promise<boolean> {
  return invoke<boolean>('is_storage_configured')
}

/** List available RIVET_HOME locations (current/default/portable). */
export function getStorageOptions(): Promise<StorageOptions> {
  return invoke<StorageOptions>('get_storage_options')
}

/** Set RIVET_HOME and optionally migrate existing data. Requires app restart. */
export function applyStorageLocation(path: string, migrate: boolean): Promise<StorageApplyResult> {
  return invoke<StorageApplyResult>('apply_storage_location', { path, migrate })
}

/** Test-only: inspect the memoized runtime handle (null when cleared). */
export function __peekRuntimeCache(): RuntimeInfo | null {
  return cached
}

// ── Pro license（双层模式）───────────────────────────────────────────────
// Basic 免许可证即用；Pro 许可证在 Rust 侧 Ed25519 验签落盘，spawn sidecar 时
// 按验签结果注入 RIVET_PRO=1 解锁高级功能。The frontend only drives the UI +
// the network calls to the license server.

export interface ActivationStatus {
  activated: boolean
  tier: string | null
  tokenExp: number | null
  licenseExpires: number | null
  grace: boolean
  graceUntil: number | null
  reason: string
  deviceId: string
}

/** License server base URL. Override at build time via VITE_LICENSE_SERVER_URL. */
export const LICENSE_SERVER_URL = String(
  viteEnv().VITE_LICENSE_SERVER_URL ?? 'https://tianshu-license-server.huiliyi37.workers.dev',
).replace(/\/+$/, '')

/** Current local activation state (Ed25519-verified in Rust, offline-grace aware). */
export function getActivationStatus(): Promise<ActivationStatus> {
  return invoke<ActivationStatus>('activation_status')
}

/** Stable device fingerprint used to bind a license to this machine. */
export function getDeviceFingerprint(): Promise<string> {
  return invoke<string>('device_fingerprint')
}

/** Verify + persist a server-issued token; returns the recomputed status. */
export function storeLicense(token: string): Promise<ActivationStatus> {
  return invoke<ActivationStatus>('store_license', { token })
}

/** Remove the local license (revert to Basic). Applies on next sidecar spawn. */
export function deactivateLicense(): Promise<void> {
  return invoke<void>('deactivate')
}

async function serverError(res: Response): Promise<string> {
  let reason = `HTTP ${res.status}`
  try {
    const j = (await res.json()) as { error?: string }
    if (j?.error) reason = String(j.error)
  } catch { /* non-JSON body */ }
  return reason
}

/**
 * Redeem an activation code: POST /activate → Rust verifies & stores the token.
 * On success the caller should relaunch so the next sidecar spawn picks up the
 * Pro tier (RIVET_PRO env injection happens at spawn time).
 */
export async function activateWithCode(code: string): Promise<ActivationStatus> {
  const deviceId = await getDeviceFingerprint()
  const res = await fetch(`${LICENSE_SERVER_URL}/activate`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ code: code.trim(), deviceId }),
  })
  if (!res.ok) throw new Error(await serverError(res))
  const data = (await res.json()) as { token?: string }
  if (!data.token) throw new Error('no_token')
  return storeLicense(data.token)
}

/**
 * Heartbeat: POST /verify with the stored token → refresh (rolling expiry) or
 * detect revocation. Returns:
 *   - refreshed ActivationStatus on success
 *   - `{ revoked: true }` when the server explicitly revoked the license
 *   - null on network failure (offline grace period covers it)
 */
export async function verifyLicenseHeartbeat(): Promise<
  { status: ActivationStatus } | { revoked: true; reason: string } | null
> {
  const [token, deviceId] = await Promise.all([
    invoke<string | null>('license_token'),
    getDeviceFingerprint(),
  ])
  if (!token) return null
  let res: Response
  try {
    res = await fetch(`${LICENSE_SERVER_URL}/verify`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ token, deviceId }),
    })
  } catch {
    return null // offline — grace period handles it
  }
  if (!res.ok) return null
  const data = (await res.json()) as {
    valid: boolean
    reason?: string
    token?: string
  }
  if (!data.valid) {
    if (data.reason === 'revoked' || data.reason === 'license_expired') {
      await deactivateLicense()
      return { revoked: true, reason: data.reason }
    }
    return null
  }
  if (data.token) {
    const status = await storeLicense(data.token)
    return { status }
  }
  return { status: await getActivationStatus() }
}

// ── RPA 录制（Tauri 命令 + 蒸馏路由）────────────────────────────────────
// 捕获层在 Rust（desktop/src-tauri/src/recorder.rs），JSONL 落 RIVET_HOME/
// recordings；蒸馏走 sidecar 的 POST /recordings/distill（一次性 agent 会话）。

export interface RecorderPermissions {
  inputMonitoring: boolean
  accessibility: boolean
  detail: string
  supported: boolean
}

export interface RecordingSummary {
  id: string
  path: string
  startedAt: number
  eventCount: number
  durationMs: number
  apps: string[]
}

export interface RecordingStatus {
  recording: boolean
  id: string | null
  count: number
}

/** 录制权限探测。浏览器 dev（无 Tauri）与非 macOS 报 supported=false。 */
export async function getRecorderPermissions(): Promise<RecorderPermissions> {
  try {
    return await invoke<RecorderPermissions>('recorder_permissions')
  } catch {
    return { inputMonitoring: false, accessibility: false, detail: '', supported: false }
  }
}

export function startRecording(): Promise<{ id: string; path: string }> {
  return invoke<{ id: string; path: string }>('recording_start')
}

export function stopRecording(): Promise<RecordingSummary> {
  return invoke<RecordingSummary>('recording_stop')
}

export async function getRecordingStatus(): Promise<RecordingStatus> {
  try {
    return await invoke<RecordingStatus>('recording_status')
  } catch {
    return { recording: false, id: null, count: 0 }
  }
}

export async function listRecordings(): Promise<RecordingSummary[]> {
  try {
    return await invoke<RecordingSummary[]>('list_recordings')
  } catch {
    return []
  }
}

export function deleteRecording(id: string): Promise<void> {
  return invoke<void>('delete_recording', { id })
}

export function readRecording(id: string): Promise<string> {
  return invoke<string>('read_recording', { id })
}

export interface DistillResult {
  session: SessionRecord
  /** 工作流文档相对 session cwd 的路径（蒸馏 agent 写入的目标）。 */
  workflowPath: string
  eventCount: number
  apps: string[]
}

/** 录制 → 蒸馏会话：读 JSONL（Tauri）→ POST /recordings/distill（sidecar）。 */
export async function distillRecording(recordingId: string, cwd?: string): Promise<DistillResult> {
  const jsonl = await readRecording(recordingId)
  return apiPost<DistillResult>('/recordings/distill', { recordingId, jsonl, ...(cwd ? { cwd } : {}) })
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
    if (!(err instanceof Error && err.name === 'AbortError')) clearRuntimeCache()
    throw err
  }
  // Token rotated after a sidecar restart — drop the stale handle; the caller's
  // next attempt re-invokes runtime_info and picks up the new token.
  if (res.status === 401) clearRuntimeCache()
  return res
}

async function readErrorBody(res: Response): Promise<string> {
  try {
    const body = await res.json() as Record<string, unknown>
    if (typeof body.error === 'string' && body.error) return body.error
  } catch { /* body not JSON or missing error field */ }
  return ''
}

async function apiGet<T>(path: string, signal?: AbortSignal): Promise<T> {
  const res = await rivetFetch(path, signal ? { signal } : undefined)
  if (!res.ok) {
    const detail = await readErrorBody(res)
    throw new Error(detail || `GET ${path} -> ${res.status}`)
  }
  return res.json() as Promise<T>
}

async function apiPost<T>(path: string, body?: unknown): Promise<T> {
  const res = await rivetFetch(path, { method: 'POST', body: body ? JSON.stringify(body) : undefined })
  if (!res.ok) {
    const detail = await readErrorBody(res)
    throw new Error(detail || `POST ${path} -> ${res.status}`)
  }
  return res.json() as Promise<T>
}

async function apiPut<T>(path: string, body?: unknown): Promise<T> {
  const res = await rivetFetch(path, { method: 'PUT', body: body ? JSON.stringify(body) : undefined })
  if (!res.ok) {
    const detail = await readErrorBody(res)
    throw new Error(detail || `PUT ${path} -> ${res.status}`)
  }
  return res.json() as Promise<T>
}

// ── Health (N1) ─────────────────────────────────────────────────────

export function getHealth(): Promise<HealthInfo> {
  return apiGet<HealthInfo>('/health')
}

export function getEnvironment(): Promise<EnvironmentInfo> {
  return apiGet<EnvironmentInfo>('/environment')
}

/** One-click fix: set git core.autocrlf to 'input' (prevents CRLF diff noise). */
export function fixAutocrlf(): Promise<{ ok: boolean }> {
  return apiPost<{ ok: boolean }>('/config/fix-autocrlf')
}

export function getProjectTemplatesStatus(cwd: string): Promise<ProjectTemplatesStatus> {
  return apiGet<ProjectTemplatesStatus>(`/project-templates/status?cwd=${encodeURIComponent(cwd)}`)
}

export function applyProjectTemplates(cwd: string, agentsMode: 'overwrite' | 'append' | 'skip'): Promise<ProjectTemplatesApplyResult> {
  return apiPost<ProjectTemplatesApplyResult>('/project-templates/apply', { cwd, agentsMode })
}

// ── Project prefix cornerstone docs (AGENTS.md / .rivet.md) ──────────

export function getProjectDocs(cwd: string): Promise<ProjectDocs> {
  return apiGet<ProjectDocs>(`/project-docs?cwd=${encodeURIComponent(cwd)}`)
}

export function setProjectDocs(
  cwd: string,
  docs: { agentsMd?: string; rivetMd?: string },
): Promise<ProjectDocs> {
  return apiPut<ProjectDocs>('/project-docs', { cwd, ...docs })
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

/** Set the session's reasoning effort level (off/low/medium/high/max/auto). Live on a running agent. */
export function setEffort(id: string, effort: string): Promise<{ id: string; effort: string }> {
  return apiPost<{ id: string; effort: string }>(`/sessions/${id}/effort`, { effort })
}

export async function listSessions(): Promise<SessionRecord[]> {
  const { sessions } = await apiGet<{ sessions: SessionRecord[] }>('/sessions')
  return sessions
}

export async function openFile(path: string, reveal?: boolean): Promise<void> {
  await apiPost('/open-file', { path, ...(reveal ? { reveal: true } : {}) })
}

export async function listAllSessions(): Promise<SessionRecord[]> {
  const { sessions } = await apiGet<{ sessions: SessionRecord[] }>('/sessions?includeArchived=true')
  return sessions
}

/** One transcript hit from the cross-session content search. */
export type SessionSearchHit = {
  sessionId: string
  title: string
  role: 'user' | 'assistant'
  snippet: string
}

/** Search user/assistant text across all active sessions' transcripts (q >= 2 chars). */
export async function searchSessionContent(q: string, signal?: AbortSignal): Promise<SessionSearchHit[]> {
  const { results, meta } = await apiGet<{
    results: SessionSearchHit[]
    meta?: { durationMs: number; scannedFiles: number }
  }>(
    `/sessions/search?q=${encodeURIComponent(q)}`,
    signal,
  )
  if (meta) {
    perfRecord('sessionSearch.duration', meta.durationMs)
    perfRecord('sessionSearch.scannedFiles', meta.scannedFiles)
  }
  return results
}

export function getSession(id: string): Promise<SessionRecord> {
  return apiGet<SessionRecord>(`/sessions/${id}`)
}

export function sendPrompt(id: string, prompt: string, images?: string[]): Promise<SessionRecord> {
  return apiPost<SessionRecord>(`/sessions/${id}/prompt`, { prompt, ...(images?.length ? { images } : {}) })
}

/** User-dispatched background subagent. Returns the worker id; progress arrives
 *  via the session's delegation SSE events. Does not block the main turn. */
export interface DelegateWorkerInput {
  objective: string
  profile?: string
  authority?: string
  files?: string[]
}
export function delegateWorker(id: string, input: DelegateWorkerInput): Promise<{ workerId: string }> {
  return apiPost<{ workerId: string }>(`/sessions/${id}/delegate`, input)
}

/** Cancel a user-dispatched background subagent. */
export function abortDelegateWorker(id: string, workerId: string): Promise<{ ok: boolean }> {
  return apiPost<{ ok: boolean }>(`/sessions/${id}/delegate/${workerId}/abort`)
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

/** N2 — feedback on an artifact, re-injected as next-turn context.
 *  `lines` carries optional diff line-level review comments (file + old/new
 *  line + text). When `comment` is empty but `lines` is non-empty, only
 *  line-level remarks are injected. */
export function sendArtifactFeedback(
  id: string,
  artifactId: string,
  comment: string,
  lines?: ReadonlyArray<import('./types.js').LineComment>,
): Promise<SessionRecord> {
  return apiPost<SessionRecord>(`/sessions/${id}/feedback`, { artifactId, comment, lines })
}

export function abortSession(id: string): Promise<{ aborted: boolean }> {
  return apiPost<{ aborted: boolean }>(`/sessions/${id}/abort`)
}

/**
 * One-click resume of a run interrupted by a sidecar restart (resume_offer).
 * Model/domain affinity is enforced server-side (fail-closed): when the
 * original model is unavailable and no fallback is configured this rejects
 * with 409 — the caller degrades to a "start a new session" hint.
 * `switched: true` means the configured fallback model took over and the
 * prefix cache will be rebuilt (disclose it to the user).
 */
export function resumeSession(id: string): Promise<{ resumed: boolean; model: string; switched: boolean }> {
  return apiPost<{ resumed: boolean; model: string; switched: boolean }>(`/sessions/${id}/resume`)
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

/** Rename a session title. */
export async function renameSession(id: string, title: string): Promise<{ id: string; title: string }> {
  const res = await rivetFetch(`/sessions/${id}`, {
    method: 'PATCH',
    body: JSON.stringify({ title }),
  })
  if (!res.ok) throw new Error(`PATCH /sessions/${id} -> ${res.status}`)
  return res.json() as Promise<{ id: string; title: string }>
}

/** Permanently delete an archived session. */
export async function deleteSession(id: string): Promise<{ deleted: boolean; freedBytes: number }> {
  const res = await rivetFetch(`/sessions/${id}/permanent`, { method: 'DELETE' })
  if (!res.ok) throw new Error(`DELETE /sessions/${id}/permanent -> ${res.status}`)
  return res.json() as Promise<{ deleted: boolean; freedBytes: number }>
}

export interface StorageEntry {
  id: string
  title?: string
  status: string
  updatedAt: number
  bytes: number
}

export interface StorageReport {
  totalBytes: number
  sessionCount: number
  archivedCount: number
  archivedBytes: number
  archived: StorageEntry[]
}

/** Disk-usage report for the desktop session store (stat-based, cheap). */
export async function getStorageReport(): Promise<StorageReport> {
  return apiGet<StorageReport>('/storage')
}

// ── Computer Use (macOS GUI automation) settings ─────────────────────

export interface ComputerUsePermissions {
  accessibility: boolean
  screenRecording: boolean
  detail: string
}

export interface ComputerUseGrantItem {
  app: string
  grantedAt: number
}

export interface ComputerUseStatus {
  available: boolean
  /** True when the platform supports Computer Use but Pro is not active. */
  proRequired: boolean
  platform: string
  permissions: ComputerUsePermissions | null
  grants: ComputerUseGrantItem[]
}

export function getComputerUseStatus(): Promise<ComputerUseStatus> {
  return apiGet<ComputerUseStatus>('/config/computer-use')
}

export function revokeComputerUseApp(app: string): Promise<{ ok: boolean; grants: ComputerUseGrantItem[] }> {
  return apiPost<{ ok: boolean; grants: ComputerUseGrantItem[] }>('/config/computer-use/revoke', { app })
}

/**
 * Irreversibly delete archived sessions' files. `ids` targets specific ones;
 * `olderThanDays` keeps only archived idle for ≥ N days; omit both to purge all
 * archived. Active/running sessions are never touched.
 */
export async function cleanupStorage(
  opts: { ids?: string[]; olderThanDays?: number } = {},
): Promise<{ deleted: number; freedBytes: number; ids: string[] }> {
  return apiPost<{ deleted: number; freedBytes: number; ids: string[] }>('/storage/cleanup', opts)
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

/** Gap 1 — directory listing for file browser. Returns direct children. */
export async function listDir(
  id: string,
  path: string,
): Promise<{ path: string; entries: import('./types.js').DirEntry[] }> {
  const qs = path ? `?path=${encodeURIComponent(path)}` : ''
  return apiGet(`/sessions/${id}/list-dir${qs}`)
}

export function answerApproval(
  id: string,
  requestId: string,
  decision: ApprovalDecision,
  editedInput?: Record<string, unknown>,
  remember?: boolean,
): Promise<{ ok: boolean }> {
  return apiPost<{ ok: boolean }>(`/sessions/${id}/interventions/${requestId}/answer`, {
    decision,
    ...(editedInput ? { editedInput } : {}),
    ...(remember ? { remember: true } : {}),
  })
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

/** List the star-domain picker entries (Auto / domains, current flagged). */
export async function listDomains(id: string): Promise<DomainEntry[]> {
  const { entries } = await apiGet<{ entries: DomainEntry[] }>(`/sessions/${id}/domains`)
  return entries
}

/** Set a session's star domain by key ('auto' | <domainId>). */
export function setDomain(id: string, key: string): Promise<{ id: string; domain: string }> {
  return apiPost<{ id: string; domain: string }>(`/sessions/${id}/domain`, { key })
}

/** List every loaded skill with its per-session enablement status. */
export async function listSkills(id: string): Promise<SkillStatus[]> {
  const { skills } = await apiGet<SkillsResponse>(`/sessions/${id}/skills`)
  return skills
}

/**
 * Like listSkills but also returns loadErrors — skills that failed to parse from
 * .rivet/skills (e.g. a malformed installed Claude skill). Used by the Skills
 * surface so a silently-dropped skill becomes visible.
 */
export async function listSkillsDetailed(id: string): Promise<SkillsResponse> {
  const res = await apiGet<SkillsResponse>(`/sessions/${id}/skills`)
  return { skills: res.skills ?? [], loadErrors: res.loadErrors ?? [] }
}

/** Enable/disable a skill for a session (affects the discovery block). */
export function setSkillEnabled(
  id: string,
  name: string,
  enabled: boolean,
): Promise<{ id: string; name: string; enabled: boolean }> {
  return apiPost<{ id: string; name: string; enabled: boolean }>(`/sessions/${id}/skills`, { name, enabled })
}

/** List skills installable from .claude/skills (project + global) + install-cap context. */
export function listInstallableSkills(id: string): Promise<InstallableSkillsResponse> {
  return apiGet<InstallableSkillsResponse>(`/sessions/${id}/skills/installable`)
}

/**
 * Copy the named skills into .rivet/skills. No hot-load: the installed skills
 * take effect on the next session.
 */
export function installSkills(id: string, names: string[]): Promise<SkillInstallResult> {
  return apiPost<SkillInstallResult>(`/sessions/${id}/skills/install`, { names })
}

// ── Plan mode ───────────────────────────────────────────────────────

/** Toggle the session into read-only planning ('planning') or execution ('off'). */
export function setPlanMode(id: string, state: PlanModeState): Promise<{ id: string; planMode: PlanModeState }> {
  return apiPost<{ id: string; planMode: PlanModeState }>(`/sessions/${id}/plan-mode`, { state })
}

/** List this session's plans (newest first) plus the active plan-mode draft. */
export function listPlans(id: string): Promise<PlanListResponse> {
  return apiGet<PlanListResponse>(`/sessions/${id}/plans`)
}

/** Read a single plan's full markdown content. */
export async function getPlan(id: string, slug: string): Promise<PlanDoc> {
  const { plan } = await apiGet<{ plan: PlanDoc }>(`/sessions/${id}/plans/${encodeURIComponent(slug)}`)
  return plan
}

/** Edit a submitted plan's markdown before approval (review → tweak → Build). */
export function updatePlan(id: string, slug: string, content: string): Promise<{ ok: boolean }> {
  return apiPut<{ ok: boolean }>(`/sessions/${id}/plans/${encodeURIComponent(slug)}`, { content })
}

/** Build — approve a plan and start executing it. */
export function approvePlan(id: string, slug: string, selectedApproach?: string): Promise<{ ok: boolean }> {
  return apiPost<{ ok: boolean }>(
    `/sessions/${id}/plans/${encodeURIComponent(slug)}/approve`,
    selectedApproach ? { selectedApproach } : undefined,
  )
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
  /**
   * Seq of the originating `user` event, i.e. the `u-${seq}` block the rewind
   * reducer cuts at. Lets the timeline preview anchor on the exact same block a
   * fork will truncate, so preview == post-fork state. Absent when the event log
   * was trimmed/diverged (client falls back to ordinal/text heuristics).
   */
  seq?: number
}

export function getRewindPoints(id: string): Promise<{ points: RewindPoint[] }> {
  return apiGet<{ points: RewindPoint[] }>(`/sessions/${id}/rewind-points`)
}

export function rewindSession(id: string, messageIndex: number, rollbackFiles?: boolean): Promise<SessionRecord> {
  return apiPost<SessionRecord>(`/sessions/${id}/rewind`, { messageIndex, rollbackFiles })
}

// ── Precise (per-message) code rewind via FileHistory ───────────────

export interface PreciseFileEntry {
  path: string
  action: 'restore' | 'delete'
}

export interface PreciseFilePreview {
  /** false → no per-edit history for this boundary; fall back to coarse rollback. */
  available: boolean
  files: PreciseFileEntry[]
}

export interface PreciseRewindResult {
  success: boolean
  filesChanged: string[]
  error?: string
}

/** Preview the agent-edited files a precise rewind to `messageIndex` would touch. */
export function getPreciseFilePreview(id: string, messageIndex: number): Promise<PreciseFilePreview> {
  return apiPost<PreciseFilePreview>(`/sessions/${id}/rewind/file-preview`, { messageIndex })
}

/**
 * Restore agent-edited files to their state at `messageIndex` (no conversation
 * truncation). Reads the body on 200 and 409 alike so the caller can surface
 * the reason on rejection.
 */
export async function rewindFilesPrecise(id: string, messageIndex: number): Promise<PreciseRewindResult> {
  const res = await rivetFetch(`/sessions/${id}/rewind/files`, {
    method: 'POST',
    body: JSON.stringify({ messageIndex }),
  })
  const json = (await res.json().catch(() => ({}))) as Partial<PreciseRewindResult>
  return {
    success: json.success ?? false,
    filesChanged: json.filesChanged ?? [],
    error: json.error,
  }
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

// ── Background jobs (bash run_in_background) ─────────────────────────

export async function getJobs(id: string): Promise<JobState[]> {
  const { jobs } = await apiGet<{ jobs: JobState[] }>(`/sessions/${id}/jobs`)
  return jobs
}

export async function getJobLogs(id: string, jobId: string): Promise<string> {
  const { logs } = await apiGet<{ logs: string }>(
    `/sessions/${id}/jobs/${encodeURIComponent(jobId)}/logs`,
  )
  return logs
}

export function killJob(id: string, jobId: string): Promise<{ ok: boolean }> {
  return apiPost<{ ok: boolean }>(`/sessions/${id}/jobs/${encodeURIComponent(jobId)}/kill`)
}

// ── Council (I1) ────────────────────────────────────────────────────

export function conveneCouncil(
  id: string,
  input: {
    artifactId: string
    objective?: string
    seats?: { authority: string; charter?: string }[]
    rounds?: number
  },
): Promise<{ planMarkdown: string; artifactId: string }> {
  return apiPost<{ planMarkdown: string; artifactId: string }>(`/sessions/${id}/council`, input)
}

// ── Hooks (I4) ──────────────────────────────────────────────────────

export function getHooks(id: string): Promise<HooksConfig> {
  return apiGet<HooksConfig>(`/sessions/${id}/hooks`)
}

export function setHooks(id: string, hooks: HookEntry[]): Promise<HooksConfig> {
  return apiPut<HooksConfig>(`/sessions/${id}/hooks`, { hooks })
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
  retry?: { maxAttempts: number; backoffMs: number }
  /** 付费版 v1 · T2 — 审查策略（非 always-review 需要 Pro）。 */
  reviewPolicy?: 'always-review' | 'first-runs' | 'auto-proceed'
}): Promise<ScheduledTask> {
  return apiPost<ScheduledTask>('/schedule', input)
}

/** 试跑驱动信任 · Phase 1 — 立即手动触发一次（恒有人值守，计入 triggerCount）。 */
export function runScheduleNow(id: string): Promise<{ id: string; triggered: boolean }> {
  return apiPost<{ id: string; triggered: boolean }>(`/schedule/${id}/run-now`, {})
}

export function pauseSchedule(id: string, enabled: boolean): Promise<{ id: string; enabled: boolean }> {
  return apiPost<{ id: string; enabled: boolean }>(`/schedule/${id}/pause`, { enabled })
}

export async function deleteSchedule(id: string): Promise<void> {
  const res = await rivetFetch(`/schedule/${id}`, { method: 'DELETE' })
  if (!res.ok) throw new Error(`DELETE /schedule/${id} -> ${res.status}`)
}

// ── Tasks (execution history for automations) ───────────────────────

/** List task execution records. The server returns all; callers filter by
 *  scheduledTaskId client-side (the GET handler reads no query params). */
export async function listTasks(): Promise<TaskRecord[]> {
  const { tasks } = await apiGet<{ tasks: TaskRecord[] }>('/tasks')
  return tasks
}

export async function getTask(id: string): Promise<TaskRecord> {
  const { task } = await apiGet<{ task: TaskRecord }>(`/tasks/${encodeURIComponent(id)}`)
  return task
}

export async function cancelTask(id: string): Promise<TaskRecord> {
  const { task } = await apiPost<{ task: TaskRecord }>(`/tasks/${encodeURIComponent(id)}/cancel`)
  return task
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

/** Pending inline review comment (mirrors gh-cli PrReviewComment). */
export interface PrReviewComment {
  path: string
  oldLine?: number
  newLine?: number
  body: string
}

/** Review submission payload (mirrors gh-cli PrReviewInput — keep in sync). */
export interface PrReviewInput {
  event: 'APPROVE' | 'REQUEST_CHANGES' | 'COMMENT'
  body: string
  comments: PrReviewComment[]
}

export async function listGithubPrs(): Promise<{ prs: PrSummary[]; ghAvailable: boolean }> {
  return apiGet<{ prs: PrSummary[]; ghAvailable: boolean }>('/github/prs')
}

export async function getGithubPr(number: number): Promise<PrDetail> {
  return apiGet<PrDetail>(`/github/prs/${number}`)
}

export async function getGithubPrDiff(number: number): Promise<string> {
  const { diff } = await apiGet<{ diff: string }>(`/github/prs/${number}/diff`)
  return diff
}

/**
 * Submit a PR review. On failure, surfaces gh's stderr from the JSON error body
 * (apiPost would discard it) so the caller can show what actually went wrong.
 */
export async function submitGithubPrReview(number: number, input: PrReviewInput): Promise<void> {
  const res = await rivetFetch(`/github/prs/${number}/review`, {
    method: 'POST',
    body: JSON.stringify(input),
  })
  if (!res.ok) {
    let message = `POST /github/prs/${number}/review -> ${res.status}`
    try {
      const err = (await res.json()) as { error?: string }
      if (err?.error) message = err.error
    } catch { /* body not JSON — keep the status message */ }
    throw new Error(message)
  }
}

// ── Config: Provider Management ─────────────────────────────────────

export interface ProviderListItem {
  name: string
  label: string
  baseUrl: string
  isDefault: boolean
  keyStatus: { source: 'inline' | 'env' | 'none'; ref: string }
  models: { id: string; alias?: string; contextWindow: number; maxTokens: number; supportsVision?: boolean }[]
  isPreset: boolean
  allowProFallback: boolean
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

export interface SetupConfigProviderInput {
  providerName: string
  apiKey?: string
  apiKeyEnv?: string
  baseUrl?: string
  makeDefault?: boolean
  allowProFallback?: boolean
  model?: {
    id: string
    alias?: string
    contextWindow: number
    maxTokens: number
  }
}

export function setupConfigProvider(
  input: SetupConfigProviderInput,
): Promise<{ ok: boolean; providerName: string }> {
  return apiPost('/config/providers', input)
}

export interface SetupCustomProviderInput {
  providerName: string
  baseUrl: string
  /** Optional — local deployments (Ollama/vLLM) need no key. */
  apiKey?: string
  model: {
    id: string
    alias?: string
    contextWindow: number
    maxTokens: number
  }
  makeDefault?: boolean
  allowProFallback?: boolean
}

/** Create a brand-new OpenAI-compatible provider from scratch (no preset needed).
 *  Supports Ollama / vLLM / OpenAI direct / third-party compatible endpoints. */
export function setupCustomProvider(
  input: SetupCustomProviderInput,
): Promise<{ ok: boolean; providerName: string }> {
  return apiPost('/config/providers/custom', input)
}

export interface BalanceInfo {
  currency: string
  totalBalance: string
}

export interface BalanceResult {
  isAvailable: boolean
  balances: BalanceInfo[]
}

/** Query DeepSeek account balance (official API). Returns null for non-DeepSeek providers. */
export function getBalance(): Promise<{ balance: BalanceResult | null }> {
  return apiGet<{ balance: BalanceResult | null }>('/config/balance')
}

export function removeConfigProvider(name: string): Promise<{ ok: boolean }> {
  return rivetFetch(`/config/providers/${name}`, { method: 'DELETE' })
    .then(r => r.json() as Promise<{ ok: boolean }>)
}

export function removeProviderModel(providerName: string, modelId: string): Promise<{ ok: boolean }> {
  return rivetFetch(`/config/providers/${providerName}/models/${encodeURIComponent(modelId)}`, { method: 'DELETE' })
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

export function setProviderAllowProFallback(
  name: string,
  allowProFallback: boolean,
): Promise<{ ok: boolean; allowProFallback: boolean }> {
  return apiPut<{ ok: boolean; allowProFallback: boolean }>(`/config/providers/${name}/allow-pro-fallback`, { allowProFallback })
}

// ── Config: Sub-agent / Review model routing ────────────────────────

/** A single sub-agent override target: which provider + model to run on. */
export interface RoutingTarget {
  provider: string
  model: string
}

/** agent.review block — review/verify/patch worker model routing + toggles. */
export interface ReviewRoutingConfig {
  /** Keyed by worker profile name (e.g. 'reviewer', 'adversarial_verifier'). */
  profiles: Record<string, RoutingTarget>
  /** Skip deliver_task post-commit auto review entirely. */
  skipAuto: boolean
  /** Docs/rename-only changes bypass review workers + unverified RED gate. */
  mechanicalFastPath: boolean
}

/** workers block — general capability-task sub-agent routing. */
export interface WorkersRoutingConfig {
  /** Named profiles: profileName → provider+model. */
  profiles: Record<string, RoutingTarget>
  /** Capability task → profile name. */
  routing: Record<string, string>
}

/** One council seat. provider+model (when both set) route that seat to a
 *  dedicated model — enabling heterogeneous councils (e.g. one DeepSeek-Pro seat
 *  + one GLM seat). Falls back to the session model when unset/credential-less. */
export interface CouncilSeatConfig {
  authority: string
  charter?: string
  tierHint?: 'cheap' | 'balanced' | 'strong'
  noDowngrade?: boolean
  provider?: string
  model?: string
}

export interface CouncilRoutingConfig {
  /** When non-empty, overrides the built-in tianquan/tianfu/tianxuan default. */
  seats: CouncilSeatConfig[]
}

export interface RoutingConfig {
  review: ReviewRoutingConfig
  workers: WorkersRoutingConfig
  council: CouncilRoutingConfig
}

export function getRoutingConfig(): Promise<RoutingConfig> {
  return apiGet<RoutingConfig>('/config/routing')
}

export function setRoutingConfig(
  input: { review?: ReviewRoutingConfig; workers?: WorkersRoutingConfig; council?: CouncilRoutingConfig },
): Promise<{ ok: boolean } & RoutingConfig> {
  return apiPut<{ ok: boolean } & RoutingConfig>('/config/routing', input)
}

// ── Editor / target-platform conventions ────────────────────────────
export type EditorPlatform = 'auto' | 'windows' | 'macos' | 'linux'
export type EditorEol = 'auto' | 'lf' | 'crlf'
export interface EditorConfig { platform: EditorPlatform; eol: EditorEol }

export function getEditorConfig(): Promise<EditorConfig> {
  return apiGet<EditorConfig>('/config/editor')
}

export function setEditorConfig(
  input: { platform?: EditorPlatform; eol?: EditorEol },
): Promise<{ ok: boolean } & EditorConfig> {
  return apiPut<{ ok: boolean } & EditorConfig>('/config/editor', input)
}

// ── Shell / Git Bash + git 路径（Windows 命令执行 / 环境探测）──────────
/** `exists`: true/false when a path is set (probed), null when unset. */
export interface ShellConfig {
  gitBashPath: string
  exists: boolean | null
  gitPath: string
  gitExists: boolean | null
}

export function getShellConfig(): Promise<ShellConfig> {
  return apiGet<ShellConfig>('/config/shell')
}

export function setShellConfig(
  input: { gitBashPath?: string; gitPath?: string },
): Promise<{ ok: boolean } & ShellConfig> {
  return apiPut<{ ok: boolean } & ShellConfig>('/config/shell', input)
}

// ── Auto 检查点 (C3) ─────────────────────────────────────────────

export interface CheckpointConfig {
  /** Auto mode pause interval (turns). 0 = off. */
  checkpointEveryTurns: number
}

export function getCheckpointConfig(): Promise<CheckpointConfig> {
  return apiGet<CheckpointConfig>('/config/checkpoint')
}

export function setCheckpointConfig(
  input: { checkpointEveryTurns?: number },
): Promise<{ ok: boolean } & CheckpointConfig> {
  return apiPut<{ ok: boolean } & CheckpointConfig>('/config/checkpoint', input)
}

// ── Vision bridge (multimodal image recognition) ──────────────────────

export interface VisionModelConfig {
  provider: string
  model: string
  prompt?: string
  maxTokens: number
}

export function getVisionModelConfig(): Promise<{ config: VisionModelConfig | null }> {
  return apiGet<{ config: VisionModelConfig | null }>('/config/vision-model')
}

export function setVisionModelConfig(
  config: VisionModelConfig | null,
): Promise<{ ok: boolean; config: VisionModelConfig | null }> {
  return apiPut<{ ok: boolean; config: VisionModelConfig | null }>('/config/vision-model', { config })
}

// ── Codex 式常驻目录授权（agent.permissions.additional*Dirs）───────────

/** One standing directory grant. `exists: false` = path missing on disk (grant
 *  is skipped fail-closed at session start — likely a typo or unplugged drive). */
export interface PermissionDirEntry { path: string; exists: boolean }

export interface PermissionDirs {
  readDirs: PermissionDirEntry[]
  writeDirs: PermissionDirEntry[]
}

export function getPermissionDirs(): Promise<PermissionDirs> {
  return apiGet<PermissionDirs>('/config/permission-dirs')
}

/** Replaces both lists. Additions apply to the running sidecar immediately;
 *  removals take effect on the next sidecar start (`restartRequired: true`). */
export function setPermissionDirs(
  input: { additionalReadDirs?: string[]; additionalWriteDirs?: string[] },
): Promise<{ ok: boolean; restartRequired: boolean } & PermissionDirs> {
  return apiPut<{ ok: boolean; restartRequired: boolean } & PermissionDirs>('/config/permission-dirs', input)
}

// ── MCP (Model Context Protocol) ────────────────────────────────────

import type { McpStatusResponse, McpServerConfig, McpServerToolsResponse, McpPresetsResponse } from './types'

export async function getMcpStatus(): Promise<McpStatusResponse> {
  return apiGet<McpStatusResponse>('/mcp/status')
}

export async function getMcpPresets(): Promise<McpPresetsResponse> {
  return apiGet<McpPresetsResponse>('/mcp/presets')
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

// ── Plugins（插件市场 — /plugins/* REST）─────────────────────────────

/** Catalog entry from GET /plugins/presets (static first-party catalog +
 *  installed/enabled state overlay computed server-side). */
export interface PluginPreset {
  id: string
  name: string
  description: string
  category: 'office' | 'dev' | 'productivity' | 'design'
  /** Repo-relative install source — resolved against the sidecar cwd. */
  installPath: string
  tools: string[]
  permissions: { fs?: boolean; net?: boolean; shell?: boolean }
  installed: boolean
  enabled: boolean
}

/** Installed plugin from GET /plugins/installed (includes non-preset plugins). */
export interface InstalledPlugin {
  name: string
  version: string
  description: string
  installPath: string
  entry: string
  toolCount: number
  toolNames: string[]
  enabled: boolean
}

/** Manifest shape returned by the install preflight (permissions review). */
export interface PluginManifestPreview {
  name?: string
  version?: string
  description?: string
  tools?: Array<{ name: string; description?: string }>
  permissions?: { fs?: boolean; net?: boolean; shell?: boolean }
}

export function listPluginPresets(): Promise<{ presets: PluginPreset[] }> {
  return apiGet<{ presets: PluginPreset[] }>('/plugins/presets')
}

export function listInstalledPlugins(): Promise<{ plugins: InstalledPlugin[] }> {
  return apiGet<{ plugins: InstalledPlugin[] }>('/plugins/installed')
}

/** Install a plugin from a local path (confirm: true executes the install).
 *  Preset cards confirm from catalog data and call this directly. */
export function installPlugin(
  path: string,
): Promise<{ ok: boolean; manifest?: PluginManifestPreview; message?: string }> {
  return apiPost<{ ok: boolean; manifest?: PluginManifestPreview; message?: string }>(
    '/plugins/install', { path, confirm: true },
  )
}

/** Two-phase preflight for custom-path installs: without confirm the server
 *  answers 400 + manifest for caller-side review — that 400 is a protocol
 *  response, not a failure, so this bypasses apiPost's throw-on-non-2xx. */
export async function preflightPluginInstall(
  path: string,
): Promise<{ ok: boolean; manifest?: PluginManifestPreview; error?: string }> {
  const res = await rivetFetch('/plugins/install', {
    method: 'POST',
    body: JSON.stringify({ path }),
  })
  const body = await res.json() as { ok?: boolean; manifest?: PluginManifestPreview; error?: string }
  // needs-confirm 400 with a manifest = successful preflight.
  if (res.status === 400 && body.manifest) return { ok: true, manifest: body.manifest }
  if (!res.ok) return { ok: false, error: body.error ?? `POST /plugins/install -> ${res.status}` }
  return { ok: true, manifest: body.manifest }
}

export function setPluginEnabled(
  name: string, enabled: boolean,
): Promise<{ ok: boolean; name: string; enabled: boolean; message?: string }> {
  return apiPost<{ ok: boolean; name: string; enabled: boolean; message?: string }>(
    '/plugins/enable', { name, enabled },
  )
}

export async function removePlugin(name: string): Promise<{ ok: boolean; message?: string }> {
  const res = await rivetFetch(`/plugins/${encodeURIComponent(name)}`, { method: 'DELETE' })
  if (!res.ok) {
    const detail = await readErrorBody(res)
    throw new Error(detail || `DELETE /plugins/${name} -> ${res.status}`)
  }
  return res.json() as Promise<{ ok: boolean; message?: string }>
}

// ── Git graph ───────────────────────────────────────────────────────

export function getGitGraph(maxCount?: number): Promise<GitGraphResponse> {
  const qs = maxCount !== undefined ? `?maxCount=${maxCount}` : ''
  return apiGet<GitGraphResponse>(`/git/graph${qs}`)
}

/** Working-tree changes relative to HEAD (file list only — per-file diff is on-demand). */
export function getWorkingTree(sessionId?: string): Promise<WorkingTreeResponse> {
  if (sessionId) return apiGet<WorkingTreeResponse>(`/sessions/${sessionId}/git/working-tree`)
  return apiGet<WorkingTreeResponse>('/git/working-tree')
}

/** Unified diff of a single file relative to the session baseline (or HEAD).
 *  Empty string = no textual diff (binary/untracked). */
export function getFileDiff(path: string, sessionId?: string): Promise<{ diff: string }> {
  if (sessionId) return apiGet<{ diff: string }>(`/sessions/${sessionId}/git/diff?path=${encodeURIComponent(path)}`)
  return apiGet<{ diff: string }>(`/git/diff?path=${encodeURIComponent(path)}`)
}

// ── Change landing (Changes tab action bar) ─────────────────────────

export interface LandingCommitResult {
  ok: boolean
  sha?: string
  nothingToCommit?: boolean
  error?: string
}

export interface LandingMergeResult {
  ok: boolean
  sha?: string
  nothingToMerge?: boolean
  conflictFiles?: string[]
  error?: string
}

export interface LandingPrResult {
  ok: boolean
  url?: string
  error?: string
}

/** Landing endpoints report expected failures (dirty workspace, conflicts,
 *  gh errors) as structured 409 bodies — parse those instead of throwing. */
async function apiPostLanding<T>(path: string, body?: unknown): Promise<T> {
  const res = await rivetFetch(path, { method: 'POST', body: body ? JSON.stringify(body) : undefined })
  if (!res.ok && res.status !== 409) throw new Error(`POST ${path} -> ${res.status}`)
  return res.json() as Promise<T>
}

/** Server-direct commit of everything in the session cwd. */
export function commitSessionChanges(sessionId: string, message?: string): Promise<LandingCommitResult> {
  return apiPostLanding<LandingCommitResult>(`/sessions/${sessionId}/git/commit`, message ? { message } : {})
}

/** Squash-merge the session worktree branch back into the main workspace. */
export function mergeSessionBack(sessionId: string): Promise<LandingMergeResult> {
  return apiPostLanding<LandingMergeResult>(`/sessions/${sessionId}/git/merge-back`, {})
}

/** Push the session worktree branch and open a PR via gh. */
export function createSessionPr(sessionId: string, title?: string, body?: string): Promise<LandingPrResult> {
  return apiPostLanding<LandingPrResult>(`/sessions/${sessionId}/git/pr`, { title, body })
}
