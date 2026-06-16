import type { DelegationNode } from '../runtime/types'

// T4 — subagent fleet panel (Codex `Down` panel / Antigravity Manager parity).
// Visual language ported from the 子代理流程 design prototype: a summary header
// with per-status counts, then per-worker rows carrying a status dot (running
// pulse), worker id, role profile tag, a colored status badge, elapsed time, and
// the latest progress line. blocked/failed/escalated rows get an attention rail.
// Pure presentational — nodes are derived from the delegation event stream
// (session-manager emits workerId/parentId/profile/status/progressLine/elapsedMs),
// so this never fabricates fields the backend does not send (no model badge /
// findings / confidence yet — those need DelegationActivity enrichment).

type StatusClass = 'running' | 'ok' | 'warn' | 'bad' | 'idle'

const STATUS_META: Record<string, { label: string; cls: StatusClass }> = {
  running: { label: '运行中', cls: 'running' },
  completed: { label: '已完成', cls: 'ok' },
  passed: { label: '通过', cls: 'ok' },
  blocked: { label: '受阻', cls: 'warn' },
  escalated: { label: '升级', cls: 'warn' },
  failed: { label: '失败', cls: 'bad' },
}

function metaOf(status: string): { label: string; cls: StatusClass } {
  return STATUS_META[status] ?? { label: status || '—', cls: 'idle' }
}

function fmtElapsed(ms?: number): string {
  if (!ms || ms < 0) return ''
  const s = Math.round(ms / 1000)
  if (s < 60) return `${s}s`
  const m = Math.floor(s / 60)
  return `${m}m${String(s % 60).padStart(2, '0')}s`
}

// "wo_team:T1" → "T1"; "wo:W1" → "W1"; otherwise first 12 chars.
function shortId(workerId: string): string {
  const tail = workerId.includes(':') ? workerId.slice(workerId.lastIndexOf(':') + 1) : workerId
  return tail.length > 0 ? tail : workerId.slice(0, 12)
}

export function DelegationTree({ nodes }: { nodes: Record<string, DelegationNode> }) {
  const list = Object.values(nodes).sort((a, b) => a.updatedAt - b.updatedAt)
  if (list.length === 0) return null

  const total = list.length
  const running = list.filter((n) => n.status === 'running').length
  const blocked = list.filter((n) => n.status === 'blocked').length
  const escalated = list.filter((n) => n.status === 'escalated').length
  const failed = list.filter((n) => n.status === 'failed').length
  const done = list.filter((n) => n.status === 'passed' || n.status === 'completed').length
  const attention = blocked + escalated + failed

  const byParent = new Map<string | undefined, DelegationNode[]>()
  for (const n of list) {
    const key = n.parentId
    const arr = byParent.get(key) ?? []
    arr.push(n)
    byParent.set(key, arr)
  }

  const render = (parentId: string | undefined, depth: number): React.ReactNode =>
    (byParent.get(parentId) ?? []).map((n) => {
      const { label, cls } = metaOf(n.status)
      const elapsed = fmtElapsed(n.elapsedMs)
      const attn = cls === 'warn' || cls === 'bad'
      return (
        <div
          key={n.workerId}
          className={`deleg-node${attn ? ` attention ${cls}` : ''}`}
          style={{ marginLeft: depth * 14 }}
        >
          <div className="deleg-row">
            <span className={`dot ${cls}${cls === 'running' ? ' pulse' : ''}`} />
            <span className="deleg-id" title={n.workerId}>{shortId(n.workerId)}</span>
            {n.profile && <span className="deleg-profile">{n.profile}</span>}
            {n.objective && <span className="obj">{n.objective}</span>}
            <span className={`deleg-badge ${cls}`}>
              {cls === 'ok' ? '✓ ' : ''}{label}
            </span>
            {elapsed && <span className="deleg-elapsed">{elapsed}</span>}
          </div>
          {n.progressLine && <div className="deleg-progress">⎿ {n.progressLine}</div>}
          {render(n.workerId, depth + 1)}
        </div>
      )
    })

  return (
    <div className="delegation-tree">
      <div className="deleg-header">
        <span className="deleg-title">子代理</span>
        <span className="deleg-count">
          已启动 {total} 个 · {done}/{total} 完成{attention > 0 ? ` · ${attention} 需关注` : ''}
        </span>
        <span className="deleg-chips">
          {running > 0 && <span className="deleg-chip running">● {running} 运行</span>}
          {blocked > 0 && <span className="deleg-chip warn">● {blocked} 受阻</span>}
          {escalated > 0 && <span className="deleg-chip warn">● {escalated} 升级</span>}
          {failed > 0 && <span className="deleg-chip bad">● {failed} 失败</span>}
          {done > 0 && <span className="deleg-chip ok">● {done} 通过</span>}
        </span>
      </div>
      {render(undefined, 0)}
    </div>
  )
}
