import type { SessionRecord } from '../runtime/types'
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
  if (s.pendingApprovals > 0) return { reason: 'approval', detail: `${s.pendingApprovals} 待审批` }
  if (s.status === 'failed') return { reason: 'failed', detail: s.error || '失败' }
  if (s.status === 'completed') return { reason: 'completed', detail: '已完成' }
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
