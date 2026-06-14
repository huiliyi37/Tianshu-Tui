import type { DelegationNode } from '../runtime/types'

// Renders the delegation tree for a session (N3). Nodes are derived from the
// event stream (delegate_task/batch/team_orchestrate tool events) by the
// server layer, so this stays a pure presentational view.
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
    (byParent.get(parentId) ?? []).map((n) => (
      <div key={n.workerId} className="deleg-node" style={{ paddingLeft: depth * 16 }}>
        <span className={`dot ${n.status}`} />
        <span className="obj">{n.objective || n.workerId.slice(0, 8)}</span>
        <span className="meta">{n.status}{n.phase ? ` · ${n.phase}` : ''}</span>
        {render(n.workerId, depth + 1)}
      </div>
    ))

  return (
    <div className="delegation-tree">
      <div className="deleg-title">委派树</div>
      {render(undefined, 0)}
    </div>
  )
}
