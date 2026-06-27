import { useState, useMemo } from 'react'
import { useUiState } from '../state/store'
import { useSessionEvents } from '../state/use-session-events'
import type { DelegationNode } from '../runtime/types'

// DelegationSurface — dedicated surface for visualizing the delegation tree.
// Reuses the live `delegation` state from the active session's event stream
// (event-reducer aggregates `delegation` events into Record<workerId, node>).
// Unlike the compact DelegationTree embedded in ThreadView, this surface shows
// a full tree with a detail sidebar (model/provider/cost/elapsed) and supports
// node selection + status filtering.

export interface TreeNode {
  node: DelegationNode
  children: TreeNode[]
  depth: number
}

/**
 * Build a forest of delegation nodes from the flat worker map.
 * - Nodes with no parentId (or a parentId that doesn't exist) become roots.
 * - Orphan handling: a node referencing a missing parent is promoted to root
 *   rather than dropped, so partial event streams still render.
 * - Cycle-safe: visited tracking prevents infinite loops on circular refs.
 * - Siblings ordered by updatedAt ascending (oldest first = spawn order).
 * Pure + exported for unit tests.
 */
export function buildDelegationForest(nodes: Record<string, DelegationNode>): TreeNode[] {
  const ids = Object.keys(nodes)

  // Index children by parent for O(1) lookup.
  const childrenOf = new Map<string | undefined, DelegationNode[]>()
  for (const n of Object.values(nodes)) {
    const arr = childrenOf.get(n.parentId) ?? []
    arr.push(n)
    childrenOf.set(n.parentId, arr)
  }
  for (const arr of childrenOf.values()) {
    arr.sort((a, b) => a.updatedAt - b.updatedAt)
  }

  // A node is a root if its parentId is undefined OR not present in the node map.
  const idSet = new Set(ids)
  const isRoot = (n: DelegationNode): boolean =>
    n.parentId === undefined || !idSet.has(n.parentId)

  const build = (parent: DelegationNode, depth: number, visited: Set<string>): TreeNode => {
    const kids = childrenOf.get(parent.workerId) ?? []
    const children: TreeNode[] = []
    for (const k of kids) {
      if (visited.has(k.workerId)) continue // cycle guard
      visited.add(k.workerId)
      children.push(build(k, depth + 1, visited))
    }
    return { node: parent, children, depth }
  }

  const forest: TreeNode[] = []
  const globalVisited = new Set<string>()
  const buildRoots = (roots: DelegationNode[]) => {
    for (const r of roots) {
      if (globalVisited.has(r.workerId)) continue
      globalVisited.add(r.workerId)
      forest.push(build(r, 0, globalVisited))
    }
  }
  // Pass 1: nodes with no parent (or a missing parent) are roots.
  buildRoots(Object.values(nodes).filter(isRoot).sort((a, b) => a.updatedAt - b.updatedAt))
  // Pass 2: any node not yet reached is in a cycle or an orphan chain —
  // promote the earliest-updated one as a synthetic root so nothing is lost.
  const remaining = Object.values(nodes)
    .filter((n) => !globalVisited.has(n.workerId))
    .sort((a, b) => a.updatedAt - b.updatedAt)
  buildRoots(remaining)
  return forest
}

// ── Formatting helpers (mirrors InsightsSurface conventions) ────

function formatMs(ms?: number): string {
  if (!ms || ms < 0) return '—'
  if (ms < 1000) return `${ms}ms`
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`
  return `${(ms / 60_000).toFixed(1)}m`
}

function formatTokens(n?: number): string {
  if (!n) return '—'
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(2)}M`
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`
  return String(n)
}

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

function shortId(workerId: string): string {
  const tail = workerId.includes(':') ? workerId.slice(workerId.lastIndexOf(':') + 1) : workerId
  return tail.length > 0 ? tail : workerId.slice(0, 12)
}

// ── Filter chip ────────────────────────────────────────────────

type FilterKind = 'all' | 'running' | 'attention' | 'done'

const FILTERS: Record<FilterKind, { label: string; match: (n: DelegationNode) => boolean }> = {
  all: { label: '全部', match: () => true },
  running: { label: '运行中', match: (n) => n.status === 'running' },
  attention: {
    label: '需关注',
    match: (n) => n.status === 'blocked' || n.status === 'escalated' || n.status === 'failed',
  },
  done: {
    label: '已完成',
    match: (n) => n.status === 'completed' || n.status === 'passed',
  },
}

// ── Node row component ─────────────────────────────────────────

function NodeRow({
  t,
  selected,
  onSelect,
  dimmed,
}: {
  t: TreeNode
  selected: boolean
  onSelect: (n: DelegationNode) => void
  dimmed: boolean
}) {
  const { node: n, depth } = t
  const { label, cls } = metaOf(n.status)
  const hasChildren = t.children.length > 0
  return (
    <>
      <div
        className={`del-node ${selected ? 'selected' : ''} ${cls} ${dimmed ? 'dimmed' : ''}`}
        style={{ paddingLeft: `${12 + depth * 18}px` }}
        onClick={() => onSelect(n)}
      >
        <span className={`del-dot ${cls}${cls === 'running' ? ' pulse' : ''}`} />
        <span className="del-id" title={n.workerId}>{shortId(n.workerId)}</span>
        {n.profile && <span className="del-profile">{n.profile}</span>}
        {n.model && <span className="del-model">{n.model}</span>}
        <span className={`del-badge ${cls}`}>{label}</span>
        {n.elapsedMs ? <span className="del-elapsed">{formatMs(n.elapsedMs)}</span> : null}
        {hasChildren && <span className="del-kids">{t.children.length}</span>}
      </div>
      {t.children.map((c: TreeNode) => (
        <NodeRow key={c.node.workerId} t={c} selected={selected} onSelect={onSelect} dimmed={dimmed} />
      ))}
    </>
  )
}

// ── Detail sidebar ─────────────────────────────────────────────

function DetailPanel({ n }: { n: DelegationNode | null }) {
  if (!n) {
    return <div className="del-detail-empty">选择一个节点查看详情</div>
  }
  const { label, cls } = metaOf(n.status)
  const usage = n.usage
  return (
    <div className="del-detail">
      <div className="del-detail-head">
        <span className={`del-dot ${cls}`} />
        <span className="del-detail-id" title={n.workerId}>{shortId(n.workerId)}</span>
        <span className={`del-badge ${cls}`}>{label}</span>
      </div>
      <dl className="del-detail-grid">
        <dt>角色</dt><dd>{n.profile ?? '—'}</dd>
        <dt>模型</dt><dd>{n.model ?? '—'}</dd>
        <dt>Provider</dt><dd>{n.provider ?? '—'}</dd>
        <dt>耗时</dt><dd>{formatMs(n.elapsedMs)}</dd>
        <dt>父节点</dt><dd>{n.parentId ? shortId(n.parentId) : '— (根)'}</dd>
      </dl>
      {n.objective && (
        <div className="del-detail-obj">
          <div className="del-detail-label">目标</div>
          <div className="del-detail-text">{n.objective}</div>
        </div>
      )}
      {n.progressLine && (
        <div className="del-detail-prog">
          <div className="del-detail-label">进度</div>
          <div className="del-detail-text">⎿ {n.progressLine}</div>
        </div>
      )}
      {usage && (
        <div className="del-detail-usage">
          <div className="del-detail-label">Token 用量</div>
          <dl className="del-usage-grid">
            <dt>输入</dt><dd>{formatTokens(usage.input_tokens)}</dd>
            <dt>输出</dt><dd>{formatTokens(usage.output_tokens)}</dd>
            <dt>缓存读</dt><dd>{formatTokens(usage.cache_read_input_tokens)}</dd>
            <dt>总计</dt><dd>{formatTokens(usage.total_tokens)}</dd>
          </dl>
        </div>
      )}
    </div>
  )
}

// ── Surface ────────────────────────────────────────────────────

export function DelegationSurface() {
  const { activeSessionId } = useUiState()
  // Delegation nodes come from the live event stream — same hook ThreadView uses.
  const view = useSessionEvents(activeSessionId)
  const delegationMap: Record<string, DelegationNode> = view.delegation

  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [filter, setFilter] = useState<FilterKind>('all')

  const forest = useMemo(() => buildDelegationForest(delegationMap), [delegationMap])

  // Flatten forest for selection lookup + filtering visibility.
  const flat = useMemo(() => {
    const out: TreeNode[] = []
    const walk = (ts: TreeNode[]) => {
      for (const t of ts) { out.push(t); walk(t.children) }
    }
    walk(forest)
    return out
  }, [forest])

  const match = FILTERS[filter]!.match
  const dimmedIds = useMemo(() => {
    if (filter === 'all') return new Set<string>()
    const keep = new Set<string>()
    // Keep a node if it or any descendant matches; also keep ancestors.
    for (const t of flat) {
      if (match(t.node)) {
        keep.add(t.node.workerId)
      }
    }
    // Propagate matches up to ancestors so filtered subtrees stay connected.
    let guard = 0
    for (;;) {
      if (guard++ > 100) break
      let added = false
      for (const t of flat) {
        if (keep.has(t.node.workerId) && t.node.parentId && !keep.has(t.node.parentId)) {
          keep.add(t.node.parentId)
          added = true
        }
      }
      if (!added) break
    }
    return new Set(flat.map(t => t.node.workerId).filter(id => !keep.has(id)))
  }, [flat, filter, match])

  const selected = selectedId ? flat.find(t => t.node.workerId === selectedId)?.node ?? null : null

  if (!activeSessionId) {
    return (
      <div className="surface-scroll">
        <div className="del-surface">
          <div className="meta">请先选择一个会话</div>
        </div>
      </div>
    )
  }

  const total = flat.length
  const running = flat.filter(t => t.node.status === 'running').length
  const attention = flat.filter(t => FILTERS.attention.match(t.node)).length
  const done = flat.filter(t => FILTERS.done.match(t.node)).length

  return (
    <div className="surface-scroll">
      <div className="del-surface">
        <header className="del-header">
          <h3>委派树</h3>
          <span className="del-summary">
            {total} 个节点 · {running} 运行 · {done} 完成{attention > 0 ? ` · ${attention} 需关注` : ''}
          </span>
        </header>

        <div className="del-filters">
          {(Object.keys(FILTERS) as FilterKind[]).map((k) => (
            <button
              key={k}
              className={`del-filter ${filter === k ? 'active' : ''}`}
              onClick={() => setFilter(k)}
            >
              {FILTERS[k]!.label}
            </button>
          ))}
        </div>

        {total === 0 ? (
          <div className="meta">暂无委派数据。运行 <code>/team</code> 或 <code>delegate_batch</code> 后这里会显示子代理树。</div>
        ) : (
          <div className="del-body">
            <div className="del-tree-panel">
              {forest.map((t) => (
                <NodeRow
                  key={t.node.workerId}
                  t={t}
                  selected={selectedId !== null}
                  onSelect={(n) => setSelectedId(n.workerId)}
                  dimmed={dimmedIds.has(t.node.workerId)}
                />
              ))}
            </div>
            <div className="del-detail-panel">
              <DetailPanel n={selected} />
            </div>
          </div>
        )}
      </div>
    </div>
  )
}
