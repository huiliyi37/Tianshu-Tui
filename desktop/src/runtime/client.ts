import { invoke } from '@tauri-apps/api/core'
import type {
  ApprovalDecision,
  ApprovalMode,
  ArtifactSummary,
  HealthInfo,
  ScheduledTask,
  SessionEvent,
  SessionRecord,
} from './types'

export interface RuntimeInfo {
  port: number
  token: string
}

let cached: RuntimeInfo | null = null

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
    const port = Number(import.meta.env.VITE_RIVET_PORT ?? 3100)
    const token = String(import.meta.env.VITE_RIVET_TOKEN ?? '')
    cached = { port, token }
  }
  return cached
}

export function runtimeBaseUrl(info: RuntimeInfo): string {
  return `http://127.0.0.1:${info.port}`
}

/**
 * Low-level authed fetch against the sidecar. Shared by the REST helpers below
 * and the SSE stream reader (runtime/sse.ts) so the Bearer token lives in one
 * place. Throws on non-2xx.
 */
export async function rivetFetch(path: string, init: RequestInit = {}): Promise<Response> {
  const info = await getRuntimeInfo()
  const headers = new Headers(init.headers)
  headers.set('Authorization', `Bearer ${info.token}`)
  if (init.body && !headers.has('Content-Type')) headers.set('Content-Type', 'application/json')
  const res = await fetch(runtimeBaseUrl(info) + path, { ...init, headers })
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

export function getSession(id: string): Promise<SessionRecord> {
  return apiGet<SessionRecord>(`/sessions/${id}`)
}

export function sendPrompt(id: string, prompt: string): Promise<SessionRecord> {
  return apiPost<SessionRecord>(`/sessions/${id}/prompt`, { prompt })
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

export function fetchEvents(id: string, since: number): Promise<{ events: SessionEvent[]; lastSeq: number }> {
  return apiGet<{ events: SessionEvent[]; lastSeq: number }>(`/sessions/${id}/events?since=${since}`)
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
