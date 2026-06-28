import { useEffect, useMemo, useState } from 'react'
import { useUiState } from '../state/store'
import { useSessions } from '../state/queries'
import { getInsights } from '../runtime/client'
import type { InsightsResponse, SessionRecord } from '../runtime/types'
import { computeDeepSeekCost, formatCny } from '../lib/pricing'

function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(2)}M`
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`
  return String(n)
}

function formatMs(ms?: number): string {
  if (!ms) return '—'
  if (ms < 1000) return `${ms}ms`
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`
  return `${(ms / 60_000).toFixed(1)}m`
}

function startOfDay(ts: number): number {
  const d = new Date(ts)
  d.setHours(0, 0, 0, 0)
  return d.getTime()
}

function isToday(ts: number): boolean {
  return startOfDay(ts) === startOfDay(Date.now())
}

function recomputeCost(insights: InsightsResponse): InsightsResponse {
  const recalcWorker = (w: InsightsResponse['workers'][number]) => ({
    ...w,
    cost: computeDeepSeekCost(
      {
        inputTokens: w.inputTokens,
        outputTokens: w.outputTokens,
        cacheReadTokens: w.cacheReadTokens,
        cacheWriteTokens: w.cacheWriteTokens,
      },
      w.model,
    ),
  })

  const workers = insights.workers.map(recalcWorker)
  const modelBreakdown = insights.modelBreakdown.map((m) => ({
    ...m,
    cost: computeDeepSeekCost(
      {
        inputTokens: m.inputTokens,
        outputTokens: m.outputTokens,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
      },
      m.model,
    ),
  }))
  // Provider breakdown lacks per-model detail; default to Flash for conservative display.
  const providerBreakdown = insights.providerBreakdown.map((p) => ({
    ...p,
    cost: computeDeepSeekCost(
      {
        inputTokens: p.inputTokens,
        outputTokens: p.outputTokens,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
      },
      'flash',
    ),
  }))

  const totalCost = workers.reduce((sum, w) => sum + w.cost, 0)
  return {
    ...insights,
    totals: { ...insights.totals, cost: totalCost },
    workers,
    modelBreakdown,
    providerBreakdown,
  }
}

function aggregateInsights(list: InsightsResponse[]): InsightsResponse {
  const empty: InsightsResponse = {
    totals: {
      workers: 0,
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      reasoningTokens: 0,
      totalTokens: 0,
      cost: 0,
    },
    cacheHitRate: null,
    workers: [],
    modelBreakdown: [],
    providerBreakdown: [],
  }
  if (list.length === 0) return empty

  const totals = list.reduce(
    (acc, cur) => ({
      workers: acc.workers + cur.totals.workers,
      inputTokens: acc.inputTokens + cur.totals.inputTokens,
      outputTokens: acc.outputTokens + cur.totals.outputTokens,
      cacheReadTokens: acc.cacheReadTokens + cur.totals.cacheReadTokens,
      cacheWriteTokens: acc.cacheWriteTokens + cur.totals.cacheWriteTokens,
      reasoningTokens: acc.reasoningTokens + cur.totals.reasoningTokens,
      totalTokens: acc.totalTokens + cur.totals.totalTokens,
      cost: acc.cost + cur.totals.cost,
    }),
    empty.totals,
  )

  const cacheHitRate =
    totals.cacheReadTokens + totals.cacheWriteTokens > 0
      ? Math.round((totals.cacheReadTokens / (totals.cacheReadTokens + totals.cacheWriteTokens)) * 100)
      : null

  return { ...empty, totals, cacheHitRate }
}

export function InsightsSurface() {
  const { activeSessionId } = useUiState()
  const sessions = useSessions()

  const [activeInsights, setActiveInsights] = useState<InsightsResponse | null>(null)
  const [dailyInsights, setDailyInsights] = useState<InsightsResponse | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const todaySessions = useMemo(
    () => (sessions.data ?? []).filter((s: SessionRecord) => isToday(s.updatedAt)),
    [sessions.data],
  )

  const load = async () => {
    setLoading(true)
    setError(null)
    try {
      const [active, ...daily] = await Promise.all([
        activeSessionId ? getInsights(activeSessionId) : null,
        ...todaySessions.map((s: SessionRecord) => getInsights(s.id)),
      ])
      setActiveInsights(active ? recomputeCost(active) : null)
      setDailyInsights(recomputeCost(aggregateInsights(daily.filter(Boolean) as InsightsResponse[])))
    } catch (err) {
      setError((err as Error).message)
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    load()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeSessionId, sessions.dataUpdatedAt])

  const renderSummary = (title: string, data: InsightsResponse | null) => {
    if (!data) {
      return (
        <section className="insights-section">
          <h4>{title}</h4>
          <div className="meta">暂无数据</div>
        </section>
      )
    }

    return (
      <section className="insights-section">
        <h4>{title}</h4>
        <div className="insights-grid">
          <div className="insight-card primary">
            <div className="insight-value">{formatCny(data.totals.cost)}</div>
            <div className="insight-label">总成本（DeepSeek V4-Flash/Pro）</div>
          </div>
          <div className="insight-card">
            <div className="insight-value">{formatTokens(data.totals.inputTokens)}</div>
            <div className="insight-label">输入 Tokens</div>
          </div>
          <div className="insight-card">
            <div className="insight-value">{formatTokens(data.totals.outputTokens)}</div>
            <div className="insight-label">输出 Tokens</div>
          </div>
          <div className="insight-card">
            <div className="insight-value">{formatTokens(data.totals.totalTokens)}</div>
            <div className="insight-label">总 Tokens</div>
          </div>
          <div className="insight-card">
            <div className="insight-value">{data.totals.workers}</div>
            <div className="insight-label">Worker 数</div>
          </div>
          {data.cacheHitRate !== null && (
            <div className="insight-card">
              <div className="insight-value">{data.cacheHitRate}%</div>
              <div className="insight-label">缓存命中率</div>
            </div>
          )}
        </div>
      </section>
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

        {renderSummary('全天汇总', dailyInsights)}

        {activeSessionId && renderSummary('当前会话', activeInsights)}

        {activeInsights && (
          <>
            <section className="insights-section">
              <h4>Worker 明细</h4>
              {activeInsights.workers.length === 0 ? (
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
                    {activeInsights.workers.map((w) => (
                      <tr key={w.workerId}>
                        <td title={w.workerId}>{w.profile ?? w.workerId.slice(-8)}</td>
                        <td>{w.model ?? '—'}</td>
                        <td>{w.provider ?? '—'}</td>
                        <td>{w.status ?? '—'}</td>
                        <td>{formatTokens(w.totalTokens)}</td>
                        <td>{formatCny(w.cost)}</td>
                        <td>{formatMs(w.elapsedMs)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </section>

            <section className="insights-section">
              <h4>模型分布</h4>
              {activeInsights.modelBreakdown.length === 0 ? (
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
                    {activeInsights.modelBreakdown.map((m) => (
                      <tr key={m.model}>
                        <td>{m.model}</td>
                        <td>{m.provider ?? '—'}</td>
                        <td>{m.count}</td>
                        <td>{formatTokens(m.totalTokens)}</td>
                        <td>{formatCny(m.cost)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </section>

            <section className="insights-section">
              <h4>Provider 分布</h4>
              {activeInsights.providerBreakdown.length === 0 ? (
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
                    {activeInsights.providerBreakdown.map((p) => (
                      <tr key={p.provider}>
                        <td>{p.provider}</td>
                        <td>{p.count}</td>
                        <td>{formatTokens(p.totalTokens)}</td>
                        <td>{formatCny(p.cost)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </section>
          </>
        )}

        {!activeSessionId && !error && (
          <div className="meta">请先选择一个会话以查看明细</div>
        )}
      </div>
    </div>
  )
}
