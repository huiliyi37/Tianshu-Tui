import i18n from '../i18n'
import type { SessionRecord, TaskRecord, TaskStatus } from '../runtime/types'
import { basename } from './projects'

// Attention center model (Q2). Cross-session feed of things needing the human:
// pending approvals, failures, and recent completions. A "seen" signature
// (id:status:pendingApprovals) lets a state change re-surface an item. Pure
// functions — `seen` is owned by the store.

export type AttentionReason = 'approval' | 'failed' | 'completed'

export interface AttentionItem {
  sessionId: string
  title: string
  cwd: string
  reason: AttentionReason
  detail: string
  sig: string
  updatedAt: number
}

export interface AttentionGroup {
  cwd: string
  name: string
  items: AttentionItem[]
}

export interface AttentionView {
  items: AttentionItem[]
  groups: AttentionGroup[]
  unseenCount: number
}

const PRIORITY: Record<AttentionReason, number> = { approval: 0, failed: 1, completed: 2 }

export function sigOf(s: Pick<SessionRecord, 'id' | 'status' | 'pendingApprovals'>): string {
  return `${s.id}:${s.status}:${s.pendingApprovals}`
}

function reasonOf(s: SessionRecord): { reason: AttentionReason; detail: string } | null {
  if (s.pendingApprovals > 0) return { reason: 'approval', detail: i18n.t('inbox:detail.pendingApprovals', { n: s.pendingApprovals }) }
  if (s.status === 'failed') return { reason: 'failed', detail: s.error || i18n.t('inbox:detail.failed') }
  if (s.status === 'completed') return { reason: 'completed', detail: i18n.t('inbox:detail.completed') }
  return null
}

export function deriveAttention(sessions: SessionRecord[], seen: Set<string>): AttentionView {
  const items: AttentionItem[] = []
  for (const s of sessions) {
    const r = reasonOf(s)
    if (!r) continue
    items.push({
      sessionId: s.id,
      title: s.title ?? s.id.slice(0, 8),
      cwd: s.cwd,
      reason: r.reason,
      detail: r.detail,
      sig: sigOf(s),
      updatedAt: s.updatedAt,
    })
  }
  items.sort((a, b) => PRIORITY[a.reason] - PRIORITY[b.reason] || b.updatedAt - a.updatedAt)

  const byCwd = new Map<string, AttentionGroup>()
  for (const it of items) {
    let g = byCwd.get(it.cwd)
    if (!g) {
      g = { cwd: it.cwd, name: basename(it.cwd) || it.cwd, items: [] }
      byCwd.set(it.cwd, g)
    }
    g.items.push(it)
  }

  const unseenCount = items.reduce((n, it) => n + (seen.has(it.sig) ? 0 : 1), 0)
  return { items, groups: [...byCwd.values()], unseenCount }
}

// ── Review Queue (Wave 4 — Codex-style triage inbox) ────────────────────────
// Sessions + automation runs merged into one queue, grouped by triage category
// instead of project: 待审批 → automation 结果 → 失败 → 已完成. Automation runs
// (TaskRecord with a scheduledTaskId, terminal status) are first-class items;
// the session they produced is deduped out of the session-derived groups so
// one run doesn't show up twice.

export type ReviewSectionId = 'approval' | 'automation' | 'failed' | 'completed'

export interface ReviewItem {
  kind: 'session' | 'automation'
  section: ReviewSectionId
  sig: string
  title: string
  detail: string
  updatedAt: number
  /** Session to jump to. Automation items link their produced session (may be absent). */
  sessionId?: string
  cwd?: string
  /** Automation-only: the run record id + owning schedule. */
  taskId?: string
  scheduledTaskId?: string
  taskStatus?: TaskStatus
}

export interface ReviewSection {
  id: ReviewSectionId
  label: string
  items: ReviewItem[]
}

export interface ReviewQueue {
  sections: ReviewSection[]
  items: ReviewItem[]
  unseenCount: number
}

export function reviewSectionLabel(id: ReviewSectionId): string {
  return i18n.t(`inbox:section.${id}`)
}

const REVIEW_SECTION_ORDER: ReviewSectionId[] = ['approval', 'automation', 'failed', 'completed']

const TASK_TERMINAL: ReadonlySet<TaskStatus> = new Set(['completed', 'failed', 'cancelled', 'timed_out'])

export function taskSig(t: Pick<TaskRecord, 'id' | 'status'>): string {
  return `task:${t.id}:${t.status}`
}

function taskUpdatedAt(t: TaskRecord): number {
  const iso = t.completedAt ?? t.startedAt ?? t.createdAt
  const ms = Date.parse(iso)
  return Number.isNaN(ms) ? 0 : ms
}

function taskStatusLabel(status: TaskStatus): string {
  return i18n.t(`inbox:taskStatus.${status}`)
}

export function deriveReviewQueue(
  sessions: SessionRecord[],
  tasks: TaskRecord[],
  seen: Set<string>,
  activeSessionId?: string | null,
): ReviewQueue {
  const items: ReviewItem[] = []

  // Automation runs — scheduled (cron) tasks in a terminal state.
  const automationSessionIds = new Set<string>()
  for (const t of tasks) {
    if (!t.scheduledTaskId || !TASK_TERMINAL.has(t.status)) continue
    if (t.sessionId) automationSessionIds.add(t.sessionId)
    const summary = t.status === 'failed'
      ? (t.error || i18n.t('inbox:detail.runFailed'))
      : (t.result?.summary || taskStatusLabel(t.status))
    items.push({
      kind: 'automation',
      section: 'automation',
      sig: taskSig(t),
      title: t.prompt.length > 60 ? `${t.prompt.slice(0, 60)}…` : t.prompt,
      detail: `${taskStatusLabel(t.status)} · ${summary.length > 80 ? `${summary.slice(0, 80)}…` : summary}`,
      updatedAt: taskUpdatedAt(t),
      ...(t.sessionId !== undefined && { sessionId: t.sessionId }),
      taskId: t.id,
      scheduledTaskId: t.scheduledTaskId,
      taskStatus: t.status,
    })
  }

  // Session-derived items — skip sessions already represented by an automation run.
  for (const s of sessions) {
    if (s.id === activeSessionId) continue
    if (automationSessionIds.has(s.id) && s.pendingApprovals === 0) continue
    const r = reasonOf(s)
    if (!r) continue
    items.push({
      kind: 'session',
      section: r.reason,
      sig: sigOf(s),
      title: s.title ?? s.id.slice(0, 8),
      detail: r.detail,
      updatedAt: s.updatedAt,
      sessionId: s.id,
      cwd: s.cwd,
    })
  }

  items.sort((a, b) => b.updatedAt - a.updatedAt)

  const sections: ReviewSection[] = REVIEW_SECTION_ORDER
    .map((id) => ({ id, label: reviewSectionLabel(id), items: items.filter((it) => it.section === id) }))
    .filter((sec) => sec.items.length > 0)

  const unseenCount = items.reduce((n, it) => n + (seen.has(it.sig) ? 0 : 1), 0)
  return { sections, items, unseenCount }
}
