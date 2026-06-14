import type { DelegationNode } from '../runtime/types'

// T4 — subagent status panel (Codex `Down` panel / Antigravity Manager parity).
// Per-worker rows with a status badge, running pulse, latest progress line, and
// elapsed time, updated in place. Nodes are derived from the event stream
// (delegation tool events + structured per-worker activity), so this stays a
// pure presentational view.
const STATUS_LABEL: Record<string, string> = {
  running: '运行中',
  completed: '已完成',
  passed: '通过',
  failed: '失败',
  blocked: '受阻',
  escalated: '升级',
}

const RUNNING = new Set(['running'])
const OK = new Set(['completed', 'passed'])
const BAD = new Set(['failed', 'blocked', 'escalated'])

function badgeClass(status: string): string {
  if (RUNNING.has(status)) return 'running'
  if (OK.has(status)) return 'ok'
  if (BAD.has(status)) return 'bad'
  return ''
}

function fmtElapsed(ms?: number): string {
  if (!ms || ms < 0) return ''
  const s = Math.round(ms / 1000)
  if (s < 60) return `${s}s`
  const m = Math.floor(s / 60)
  return `${m}m${String(s % 60).padStart(2, '0')}s`
}

export function DelegationTree({ nodes }: { nodes: Record<string, DelegationNode> }) {
  const list = Object.values(nodes).sort((a, b) => a.updatedAt - b.updatedAt)
  if (list.length === 0) return null

  const byParent = new Map<string | undefined, DelegationNode[]>()
  for (const n of list) {
    const key = n.parentId
    const arr = byParent.get(key) ?? []
    arr.push(n)
    byParent.set(key, arr)
  }

  const render = (parentId: string | undefined, depth: number): React.ReactNode =>
    (byParent.get(parentId) ?? []).map((n) => {
      const cls = badgeClass(n.status)
      const elapsed = fmtElapsed(n.elapsedMs)
      return (
        <div key={n.workerId} className="deleg-node" style={{ paddingLeft: depth * 16 }}>
          <div className="deleg-row">
            <span className={`dot ${cls} ${cls === 'running' ? 'pulse' : ''}`} />
            <span className="obj">{n.objective || n.workerId.slice(0, 12)}</span>
            <span className={`deleg-badge ${cls}`}>
              {cls === 'ok' ? '✓ ' : ''}{STATUS_LABEL[n.status] ?? n.status}
            </span>
            {elapsed && <span className="deleg-elapsed">{elapsed}</span>}
          </div>
          {n.progressLine && <div className="deleg-progress">{n.progressLine}</div>}
          {render(n.workerId, depth + 1)}
        </div>
      )
    })

  return (
    <div className="delegation-tree">
      <div className="deleg-title">子代理</div>
      {render(undefined, 0)}
    </div>
  )
}
