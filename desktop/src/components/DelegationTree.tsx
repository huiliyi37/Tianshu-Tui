import { memo, useMemo, useState } from 'react'
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
//
// memo + useMemo：ThreadView 每个流式帧都重渲染，而 delegation 引用多数帧不变。
// 不加 memo 时，每次重渲染都执行 Object.values(nodes).sort() 和多次 .filter() 计数，
// 节点数多时是无谓开销。memo 短路 + 把派生计算放进 useMemo（仅 nodes 变时重算）。

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

export interface DelegationSummary {
  total: number
  done: number
  running: number
  attention: number
}

/**
 * Derive subagent fleet counts from the delegation node map. Shared by the
 * inline pill (collapsed view) and the overlay header so they never drift.
 * `attention` = blocked + escalated + failed; `done` = passed + completed.
 */
export function summarizeDelegation(nodes: Record<string, DelegationNode>): DelegationSummary {
  const list = Object.values(nodes)
  let done = 0, running = 0, attention = 0
  for (const n of list) {
    if (n.status === 'passed' || n.status === 'completed') done++
    else if (n.status === 'running') running++
    if (n.status === 'blocked' || n.status === 'escalated' || n.status === 'failed') attention++
  }
  return { total: list.length, done, running, attention }
}

export const DelegationTree = memo(function DelegationTree({ nodes, onAdopt }: { nodes: Record<string, DelegationNode>; onAdopt?: (text: string) => void }) {
  const [viewMode, setViewMode] = useState<'list' | 'graph'>('graph')

  // 派生列表与计数放进 useMemo：仅 nodes 引用变化时才重算 Object.values + sort + filter。
  // 流式帧间 nodes 不变 → 跳过全部计算，配合外层 memo 短路整个组件 reconcile。
  const list = useMemo(() => Object.values(nodes).sort((a, b) => a.updatedAt - b.updatedAt), [nodes])

  const byParent = useMemo(() => {
    const map = new Map<string | undefined, DelegationNode[]>()
    for (const n of list) {
      const key = n.parentId
      const arr = map.get(key) ?? []
      arr.push(n)
      map.set(key, arr)
    }
    return map
  }, [list])

  // Tree Layout for Graph Mode
  const graphData = useMemo(() => {
    if (viewMode !== 'graph') return null

    const coords = new Map<string, { x: number; y: number }>()
    const workerIds = new Set(list.map((n) => n.workerId))
    const roots = list.filter((n) => !n.parentId || !workerIds.has(n.parentId))

    let currentX = 40
    const levelYGap = 160
    const nodeXGap = 240
    let maxDepth = 0

    roots.forEach((root) => {
      const computeSubtree = (nodeId: string, depth: number, offsetLeft: number): number => {
        maxDepth = Math.max(maxDepth, depth)
        const children = byParent.get(nodeId) ?? []
        const y = depth * levelYGap + 60

        if (children.length === 0) {
          coords.set(nodeId, { x: offsetLeft + nodeXGap / 2, y })
          return nodeXGap
        }

        let totalWidth = 0
        children.forEach((child) => {
          const w = computeSubtree(child.workerId, depth + 1, offsetLeft + totalWidth)
          totalWidth += w
        })

        const x = offsetLeft + totalWidth / 2
        coords.set(nodeId, { x, y })
        return totalWidth
      }

      const rootWidth = computeSubtree(root.workerId, 0, currentX)
      currentX += rootWidth + 40
    })

    return {
      coords,
      width: Math.max(currentX + 40, 600),
      height: (maxDepth + 1) * levelYGap + 80,
    }
  }, [list, byParent, viewMode])

  // 早返回放在所有 hook 之后：空列表与非空列表必须调用相同数量的 hook，
  // 否则 nodes 从无到有（首个 worker 出现）时 hook 数量变化会触发
  // "Rendered more hooks than during the previous render" 崩溃。
  if (list.length === 0) return null

  const total = list.length
  const running = list.filter((n) => n.status === 'running').length
  const blocked = list.filter((n) => n.status === 'blocked').length
  const escalated = list.filter((n) => n.status === 'escalated').length
  const failed = list.filter((n) => n.status === 'failed').length
  const done = list.filter((n) => n.status === 'passed' || n.status === 'completed').length
  const attention = blocked + escalated + failed

  const renderList = (parentId: string | undefined, depth: number): React.ReactNode =>
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
            {n.origin === 'user' && <span className="deleg-origin" title="你手动派的子代理">你派的</span>}
            {n.profile && <span className="deleg-profile">{n.profile}</span>}
            {n.objective && <span className="obj">{n.objective}</span>}
            <span className={`deleg-badge ${cls}`}>
              {cls === 'ok' ? '✓ ' : ''}{label}
            </span>
            {elapsed && <span className="deleg-elapsed">{elapsed}</span>}
          </div>
          {n.progressLine && <div className="deleg-progress">⎿ {n.progressLine}</div>}
          {onAdopt && n.summary && (
            <button
              className="deleg-adopt"
              onClick={(e) => { e.stopPropagation(); onAdopt(n.summary!) }}
              title="把子代理结果摘要填入输入框,编辑后发送"
            >
              汇入主会话 →
            </button>
          )}
          {renderList(n.workerId, depth + 1)}
        </div>
      )
    })

  return (
    <div className="delegation-tree">
      <div className="deleg-header flex items-center justify-between">
        <div className="flex items-center gap-2">
          <span className="deleg-title">子代理</span>
          <span className="deleg-count text-xs text-muted-foreground">
            已启动 {total} 个 · {done}/{total} 完成{attention > 0 ? ` · ${attention} 需关注` : ''}
          </span>
        </div>
        <div className="flex items-center gap-3">
          <span className="deleg-chips hidden md:flex">
            {running > 0 && <span className="deleg-chip running">● {running} 运行</span>}
            {blocked > 0 && <span className="deleg-chip warn">● {blocked} 受阻</span>}
            {escalated > 0 && <span className="deleg-chip warn">● {escalated} 升级</span>}
            {failed > 0 && <span className="deleg-chip bad">● {failed} 失败</span>}
            {done > 0 && <span className="deleg-chip ok">● {done} 通过</span>}
          </span>
          <div className="view-mode-toggle flex items-center bg-panel-3 rounded p-0.5 border border-border text-[10px]">
            <button
              className={`px-2 py-0.5 rounded transition-colors ${viewMode === 'graph' ? 'bg-accent text-accent-fg' : 'text-muted hover:text-text'}`}
              onClick={() => setViewMode('graph')}
            >
              思维导图
            </button>
            <button
              className={`px-2 py-0.5 rounded transition-colors ${viewMode === 'list' ? 'bg-accent text-accent-fg' : 'text-muted hover:text-text'}`}
              onClick={() => setViewMode('list')}
            >
              列表
            </button>
          </div>
        </div>
      </div>

      {viewMode === 'list' ? (
        <div className="deleg-list-view">
          {renderList(undefined, 0)}
        </div>
      ) : (
        graphData && (
          <div className="deleg-graph-view overflow-auto border border-border rounded-lg bg-panel-2 p-4 min-h-[250px]">
            <svg
              width={graphData.width}
              height={graphData.height}
              className="mx-auto"
              style={{ minWidth: '100%' }}
            >
              {/* Draw connection lines */}
              {list.map((n) => {
                if (!n.parentId) return null
                const parentCoords = graphData.coords.get(n.parentId)
                const childCoords = graphData.coords.get(n.workerId)
                if (!parentCoords || !childCoords) return null

                const px = parentCoords.x
                const py = parentCoords.y + 40 // bottom of parent card
                const cx = childCoords.x
                const cy = childCoords.y - 40 // top of child card

                // Cubic Bezier curve
                const pathD = `M ${px} ${py} C ${px} ${(py + cy) / 2}, ${cx} ${(py + cy) / 2}, ${cx} ${cy}`
                const isRunning = n.status === 'running'

                return (
                  <g key={`edge-${n.workerId}`}>
                    <path
                      d={pathD}
                      fill="none"
                      stroke={isRunning ? 'var(--accent)' : 'var(--border-strong)'}
                      strokeWidth={isRunning ? 2 : 1.5}
                      className={isRunning ? 'stroke-accent-pulse' : ''}
                      style={{ opacity: isRunning ? 1 : 0.6, transition: 'stroke 0.3s' }}
                    />
                    {isRunning && (
                      <circle r="3" fill="var(--accent-hover)" className="glowing-particle">
                        <animateMotion dur="2.5s" repeatCount="indefinite" path={pathD} />
                      </circle>
                    )}
                  </g>
                )
              })}

              {/* Draw nodes */}
              {list.map((n) => {
                const coords = graphData.coords.get(n.workerId)
                if (!coords) return null

                const { label, cls } = metaOf(n.status)
                const elapsed = fmtElapsed(n.elapsedMs)
                const isRunning = n.status === 'running'

                return (
                  <foreignObject
                    key={`node-${n.workerId}`}
                    x={coords.x - 100}
                    y={coords.y - 40}
                    width={200}
                    height={80}
                  >
                    <div className={`graph-node-card border rounded p-2 flex flex-col justify-between h-full shadow-sm transition-all ${isRunning ? 'border-accent bg-panel-3 ring-1 ring-accent/30' : 'border-border bg-panel'}`}>
                      <div className="flex items-center justify-between gap-1">
                        <div className="flex items-center gap-1.5 min-w-0">
                          <span className={`dot ${cls}${isRunning ? ' pulse' : ''}`} />
                          <span className="text-xs font-semibold truncate text-text-strong" title={n.workerId}>
                            {shortId(n.workerId)}
                          </span>
                        </div>
                        {n.profile && (
                          <span className="text-[9px] px-1 py-0.5 rounded bg-panel-2 text-muted truncate max-w-[70px]">
                            {n.profile}
                          </span>
                        )}
                      </div>
                      
                      {n.objective && (
                        <div className="text-[10px] text-text-secondary truncate my-1" title={n.objective}>
                          {n.objective}
                        </div>
                      )}

                      <div className="flex items-center justify-between text-[9px] mt-auto">
                        <span className={`px-1 rounded font-medium ${cls === 'ok' ? 'bg-success-soft text-success' : cls === 'warn' ? 'bg-warning-soft text-warning' : cls === 'bad' ? 'bg-error-soft text-error' : 'bg-panel-2 text-muted'}`}>
                          {label}
                        </span>
                        {elapsed && <span className="text-muted">{elapsed}</span>}
                      </div>
                    </div>
                  </foreignObject>
                )
              })}
            </svg>
          </div>
        )
      )}
    </div>
  )
})
