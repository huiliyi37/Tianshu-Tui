import { useEffect, useState } from 'react'
import { useUiState } from '../state/store'
import { getInsights } from '../runtime/client'
import type { InsightsResponse } from '../runtime/types'

function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(2)}M`
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`
  return String(n)
}

function formatCost(value: number): string {
  if (value === 0) return '$0.00'
  if (value < 0.0001) return '<$0.0001'
  return `$${value.toFixed(4).replace(/\.?0+$/, '')}`
}

function formatMs(ms?: number): string {
  if (!ms) return '—'
  if (ms < 1000) return `${ms}ms`
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`
  return `${(ms / 60_000).toFixed(1)}m`
}

export function InsightsSurface() {
  const { activeSessionId } = useUiState()
  const [insights, setInsights] = useState<InsightsResponse | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const load = async () => {
    if (!activeSessionId) return
    setLoading(true)
    setError(null)
    try {
      const res = await getInsights(activeSessionId)
      setInsights(res)
    } catch (err) {
      setError((err as Error).message)
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    load()
  }, [activeSessionId])

  if (!activeSessionId) {
    return (
      <div className="surface-scroll">
        <div className="insights-surface">
          <div className="meta">请先选择一个会话</div>
        </div>
      </div>
    )
  }

  return (
    <div className="surface-scroll">
      <div className="insights-surface">
        <header className="insights-header">
          <h3>Insights</h3>
          <button className="btn" onClick={load} disabled={loading}>
            {loading ? '刷新中…' : '刷新'}
          </button>
        </header>

        {error && <div className="meta warn">加载失败：{error}</div>}

        {!insights && !loading && !error && <div className="meta">暂无数据</div>}

        {insights && (
          <>
            <section className="insights-grid">
              <div className="insight-card">
                <div className="insight-value">{formatCost(insights.totals.cost)}</div>
                <div className="insight-label">总成本</div>
              </div>
              <div className="insight-card">
                <div className="insight-value">{formatTokens(insights.totals.totalTokens)}</div>
                <div className="insight-label">总 Tokens</div>
              </div>
              <div className="insight-card">
                <div className="insight-value">{insights.totals.workers}</div>
                <div className="insight-label">Worker 数</div>
              </div>
              {insights.cacheHitRate !== null && (
                <div className="insight-card">
                  <div className="insight-value">{insights.cacheHitRate}%</div>
                  <div className="insight-label">缓存命中率</div>
                </div>
              )}
            </section>

            <section className="insights-section">
              <h4>Worker 明细</h4>
              {insights.workers.length === 0 ? (
                <div className="meta">暂无 worker 数据</div>
              ) : (
                <table className="insights-table">
                  <thead>
                    <tr>
                      <th>Worker</th>
                      <th>模型</th>
                      <th>Provider</th>
                      <th>状态</th>
                      <th>Tokens</th>
                      <th>成本</th>
                      <th>耗时</th>
                    </tr>
                  </thead>
                  <tbody>
                    {insights.workers.map((w) => (
                      <tr key={w.workerId}>
                        <td title={w.workerId}>{w.profile ?? w.workerId.slice(-8)}</td>
                        <td>{w.model ?? '—'}</td>
                        <td>{w.provider ?? '—'}</td>
                        <td>{w.status ?? '—'}</td>
                        <td>{formatTokens(w.totalTokens)}</td>
                        <td>{formatCost(w.cost)}</td>
                        <td>{formatMs(w.elapsedMs)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </section>

            <section className="insights-section">
              <h4>模型分布</h4>
              {insights.modelBreakdown.length === 0 ? (
                <div className="meta">暂无模型数据</div>
              ) : (
                <table className="insights-table">
                  <thead>
                    <tr>
                      <th>模型</th>
                      <th>Provider</th>
                      <th>调用次数</th>
                      <th>Tokens</th>
                      <th>成本</th>
                    </tr>
                  </thead>
                  <tbody>
                    {insights.modelBreakdown.map((m) => (
                      <tr key={m.model}>
                        <td>{m.model}</td>
                        <td>{m.provider ?? '—'}</td>
                        <td>{m.count}</td>
                        <td>{formatTokens(m.totalTokens)}</td>
                        <td>{formatCost(m.cost)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </section>

            <section className="insights-section">
              <h4>Provider 分布</h4>
              {insights.providerBreakdown.length === 0 ? (
                <div className="meta">暂无 provider 数据</div>
              ) : (
                <table className="insights-table">
                  <thead>
                    <tr>
                      <th>Provider</th>
                      <th>调用次数</th>
                      <th>Tokens</th>
                      <th>成本</th>
                    </tr>
                  </thead>
                  <tbody>
                    {insights.providerBreakdown.map((p) => (
                      <tr key={p.provider}>
                        <td>{p.provider}</td>
                        <td>{p.count}</td>
                        <td>{formatTokens(p.totalTokens)}</td>
                        <td>{formatCost(p.cost)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </section>
          </>
        )}
      </div>
    </div>
  )
}
