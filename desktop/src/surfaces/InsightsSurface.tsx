import { useEffect, useMemo, useState, useCallback } from 'react'
import { useTranslation } from 'react-i18next'
import { useUiState } from '../state/store'
import { useSessions } from '../state/queries'
import { getInsights, getDeepSeekSummary, getDeepSeekCost } from '../runtime/client'
import type { InsightsResponse, SessionRecord } from '../runtime/types'
import type { DeepSeekSummary, DeepSeekCostReport, DeepSeekCostEntry } from '../runtime/client'

/** Format a CNY amount for display. Backend /insights returns cost in CNY
 *  (per provider-presets pricing, DeepSeek official rates). */
function formatCny(value: number): string {
  if (value === 0) return '¥0.00'
  if (value < 0.0001) return '<¥0.0001'
  return `¥${value.toFixed(4).replace(/\.?0+$/, '')}`
}

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
    mainSession: null,
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

// ── Aggregation helpers for DeepSeek cost report ──────────────────

interface ModelAggregate {
  model: string
  totalTokens: number
  totalCostCents: number
  totalRequests: number
  cacheHit: number
  cacheMiss: number
  output: number
}

function aggregateByModel(report: DeepSeekCostReport): ModelAggregate[] {
  const map = new Map<string, ModelAggregate>()
  for (const entry of report.models) {
    let agg = map.get(entry.model)
    if (!agg) {
      agg = { model: entry.model, totalTokens: 0, totalCostCents: 0, totalRequests: 0, cacheHit: 0, cacheMiss: 0, output: 0 }
      map.set(entry.model, agg)
    }
    for (const u of entry.usage) {
      agg.totalTokens += u.total_tokens
      agg.totalCostCents += u.cost_in_cents
      agg.totalRequests += u.request_count
      agg.cacheHit += u.input_cache_hit_tokens
      agg.cacheMiss += u.input_cache_miss_tokens
      agg.output += u.output_tokens
    }
  }
  return [...map.values()].sort((a, b) => b.totalCostCents - a.totalCostCents)
}

interface DailyCost {
  day: number
  costCents: number
  tokens: number
}

function aggregateByDay(report: DeepSeekCostReport, daysInMonth: number): DailyCost[] {
  const byDay = new Map<number, { costCents: number; tokens: number }>()
  for (let d = 1; d <= daysInMonth; d++) byDay.set(d, { costCents: 0, tokens: 0 })
  for (const entry of report.models) {
    // DeepSeekDesktopAssistant 的 cost API 里 usage 条目可能带 date 字段（天序号）。
    // 如果没有 date，我们无法按天分——fallback 到按 index 推断（不理想但兼容）。
    entry.usage.forEach((u: DeepSeekCostEntry, i: number) => {
      const day = u.date ? Number(u.date) : (i + 1)
      if (day < 1 || day > daysInMonth) return
      const prev = byDay.get(day)!
      prev.costCents += u.cost_in_cents
      prev.tokens += u.total_tokens
    })
  }
  return [...byDay.entries()].map(([day, v]) => ({ day, ...v }))
}

export function InsightsSurface() {
  const { t } = useTranslation('insights')
  const { activeSessionId } = useUiState()
  const sessions = useSessions()

  const [activeInsights, setActiveInsights] = useState<InsightsResponse | null>(null)
  const [dailyInsights, setDailyInsights] = useState<InsightsResponse | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  // DeepSeek platform data
  const [summary, setSummary] = useState<DeepSeekSummary | null | undefined>(undefined)
  const [costReport, setCostReport] = useState<DeepSeekCostReport | null | undefined>(undefined)
  const [selMonth, setSelMonth] = useState(() => {
    const now = new Date()
    return { month: now.getMonth() + 1, year: now.getFullYear() }
  })

  const todaySessions = useMemo(
    () => (sessions.data ?? []).filter((s: SessionRecord) => isToday(s.updatedAt)),
    [sessions.data],
  )

  const load = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const [active, ...daily] = await Promise.all([
        activeSessionId ? getInsights(activeSessionId) : null,
        ...todaySessions.map((s: SessionRecord) => getInsights(s.id)),
      ])
      setActiveInsights(active)
      setDailyInsights(aggregateInsights(daily.filter(Boolean) as InsightsResponse[]))
    } catch (err) {
      setError((err as Error).message)
    } finally {
      setLoading(false)
    }
  }, [activeSessionId, todaySessions])

  const loadPlatform = useCallback(async () => {
    try {
      const [sum, cost] = await Promise.all([
        getDeepSeekSummary(),
        getDeepSeekCost(selMonth.month, selMonth.year),
      ])
      setSummary(sum.summary)
      setCostReport(cost.cost)
    } catch {
      setSummary(null)
      setCostReport(null)
    }
  }, [selMonth])

  useEffect(() => { void load() }, [load, sessions.dataUpdatedAt])
  useEffect(() => { void loadPlatform() }, [loadPlatform])

  const shiftMonth = (delta: number) => {
    setSelMonth((prev) => {
      let m = prev.month + delta
      let y = prev.year
      if (m < 1) { m = 12; y-- }
      if (m > 12) { m = 1; y++ }
      return { month: m, year: y }
    })
  }

  const renderSummary = (title: string, data: InsightsResponse | null) => {
    if (!data) {
      return (
        <section className="insights-section">
          <h4>{title}</h4>
          <div className="meta">{t('noData')}</div>
        </section>
      )
    }
    return (
      <section className="insights-section">
        <h4>{title}</h4>
        <div className="insights-grid">
          <div className="insight-card primary">
            <div className="insight-value">{formatCny(data.totals.cost)}</div>
            <div className="insight-label">{t('summary.totalCost')}</div>
          </div>
          {data.mainSession && (
            <div className="insight-card">
              <div className="insight-value">{formatCny(data.mainSession.cost)}</div>
              <div className="insight-label">{t('summary.mainSessionCost')}</div>
            </div>
          )}
          <div className="insight-card">
            <div className="insight-value">{formatTokens(data.totals.inputTokens)}</div>
            <div className="insight-label">{t('summary.inputTokens')}</div>
          </div>
          <div className="insight-card">
            <div className="insight-value">{formatTokens(data.totals.outputTokens)}</div>
            <div className="insight-label">{t('summary.outputTokens')}</div>
          </div>
          <div className="insight-card">
            <div className="insight-value">{formatTokens(data.totals.totalTokens)}</div>
            <div className="insight-label">{t('summary.totalTokens')}</div>
          </div>
          <div className="insight-card">
            <div className="insight-value">{data.totals.workers}</div>
            <div className="insight-label">{t('summary.workerCount')}</div>
          </div>
          {data.cacheHitRate !== null && (
            <div className="insight-card">
              <div className="insight-value">{data.cacheHitRate}%</div>
              <div className="insight-label">{t('summary.cacheHitRate')}</div>
            </div>
          )}
        </div>
      </section>
    )
  }

  // ── DeepSeek platform section ───────────────────────────────────

  const renderPlatform = () => {
    if (summary === undefined) return null // loading
    if (summary === null) {
      return (
        <section className="insights-section">
          <h4>{t('platform.title')}</h4>
          <div className="meta">{t('platform.notAvailable')}</div>
        </section>
      )
    }
    return (
      <section className="insights-section">
        <h4>{t('platform.title')}</h4>
        <div className="insights-grid">
          <div className="insight-card primary">
            <div className="insight-value">{formatCny(summary.current_month_cost)}</div>
            <div className="insight-label">{t('platform.monthlyCost')}</div>
          </div>
          <div className="insight-card">
            <div className="insight-value">{formatCny(summary.current_day_cost)}</div>
            <div className="insight-label">{t('platform.dailyCost')}</div>
          </div>
          <div className="insight-card">
            <div className="insight-value">{formatCny(summary.balance_info.total_balance)}</div>
            <div className="insight-label">{t('platform.balance')}</div>
          </div>
          <div className="insight-card">
            <div className="insight-value">{summary.current_day_requests}</div>
            <div className="insight-label">{t('platform.requests')}</div>
          </div>
        </div>
      </section>
    )
  }

  // ── Cost trend chart (CSS bar chart) ────────────────────────────

  const renderTrend = () => {
    if (costReport === undefined) return null
    if (!costReport || costReport.models.length === 0) return null
    const daysInMonth = new Date(selMonth.year, selMonth.month, 0).getDate()
    const daily = aggregateByDay(costReport, daysInMonth)
    const maxCost = Math.max(...daily.map((d) => d.costCents), 1)
    const today = new Date()
    const isCurrentMonth = selMonth.month === today.getMonth() + 1 && selMonth.year === today.getFullYear()
    const todayDate = today.getDate()

    return (
      <section className="insights-section">
        <h4>{t('trend.title')}</h4>
        <div className="cost-chart">
          {daily.map((d) => (
            <div
              key={d.day}
              className={`cost-bar-col ${isCurrentMonth && d.day === todayDate ? 'today' : ''}`}
              title={`${selMonth.month}/${d.day}: ${formatCny(d.costCents / 100)} · ${formatTokens(d.tokens)}`}
            >
              <div
                className="cost-bar"
                style={{ height: `${Math.max(2, (d.costCents / maxCost) * 100)}%` }}
              />
              {(d.day === 1 || d.day % 5 === 0 || d.day === daysInMonth) && (
                <span className="cost-bar-label">{d.day}</span>
              )}
            </div>
          ))}
        </div>
      </section>
    )
  }

  // ── Model breakdown table ───────────────────────────────────────

  const renderModelBreakdown = () => {
    if (costReport === undefined) return null
    if (!costReport || costReport.models.length === 0) return null
    const models = aggregateByModel(costReport)
    const totalCacheHit = models.reduce((s, m) => s + m.cacheHit, 0)
    const totalCacheMiss = models.reduce((s, m) => s + m.cacheMiss, 0)
    const overallHitRate = totalCacheHit + totalCacheMiss > 0
      ? Math.round((totalCacheHit / (totalCacheHit + totalCacheMiss)) * 100)
      : null

    return (
      <>
        <section className="insights-section">
          <h4>{t('modelBreakdown.title')}</h4>
          <table className="insights-table">
            <thead>
              <tr>
                <th>{t('table.model', { defaultValue: 'Model' })}</th>
                <th>Tokens</th>
                <th>{t('summary.totalCost', { defaultValue: 'Cost' })}</th>
                <th>{t('platform.requests')}</th>
                <th>{t('summary.cacheHitRate', { defaultValue: 'Cache %' })}</th>
              </tr>
            </thead>
            <tbody>
              {models.map((m) => {
                const hitRate = m.cacheHit + m.cacheMiss > 0
                  ? Math.round((m.cacheHit / (m.cacheHit + m.cacheMiss)) * 100)
                  : null
                return (
                  <tr key={m.model}>
                    <td>{m.model}</td>
                    <td>{formatTokens(m.totalTokens)}</td>
                    <td>{formatCny(m.totalCostCents / 100)}</td>
                    <td>{m.totalRequests}</td>
                    <td>{hitRate !== null ? `${hitRate}%` : '—'}</td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </section>

        {overallHitRate !== null && (
          <section className="insights-section">
            <h4>{t('cache.title')}</h4>
            <div className="cache-ratio-bar">
              <div className="cache-ratio-hit" style={{ width: `${overallHitRate}%` }}>
                {t('cache.hit')} {overallHitRate}%
              </div>
              <div className="cache-ratio-miss">
                {t('cache.miss')} {100 - overallHitRate}%
              </div>
            </div>
          </section>
        )}
      </>
    )
  }

  const monthLabel = `${selMonth.year}-${String(selMonth.month).padStart(2, '0')}`

  return (
    <div className="surface-scroll">
      <div className="insights-surface">
        <header className="insights-header">
          <h3>Insights</h3>
          <div className="month-picker">
            <button className="btn-sm" onClick={() => shiftMonth(-1)} aria-label={t('monthPicker.prev')}>◀</button>
            <span className="month-label">{monthLabel}</span>
            <button className="btn-sm" onClick={() => shiftMonth(1)} aria-label={t('monthPicker.next')}>▶</button>
          </div>
          <button className="btn" onClick={() => { void load(); void loadPlatform() }} disabled={loading}>
            {loading ? t('refreshing') : t('refresh')}
          </button>
        </header>

        {error && <div className="meta warn">{t('loadFailed', { error })}</div>}

        {renderPlatform()}
        {renderTrend()}
        {renderModelBreakdown()}

        {renderSummary(t('summary.daily'), dailyInsights)}

        {activeSessionId && renderSummary(t('summary.activeSession'), activeInsights)}

        {activeInsights && (
          <>
            <section className="insights-section">
              <h4>{t('workers.title')}</h4>
              {activeInsights.workers.length === 0 ? (
                <div className="meta">{t('workers.empty')}</div>
              ) : (
                <table className="insights-table">
                  <thead>
                    <tr>
                      <th>Worker</th>
                      <th>{t('table.model', { defaultValue: 'Model' })}</th>
                      <th>Provider</th>
                      <th>{t('table.status', { defaultValue: 'Status' })}</th>
                      <th>Tokens</th>
                      <th>{t('summary.totalCost', { defaultValue: 'Cost' })}</th>
                      <th>{t('workers.elapsed', { defaultValue: 'Time' })}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {activeInsights.workers.map((w, i) => (
                      <tr key={i}>
                        <td>{w.orderId ?? `worker-${i}`}</td>
                        <td>{w.model ?? '—'}</td>
                        <td>{w.provider ?? '—'}</td>
                        <td>{w.status}</td>
                        <td>{formatTokens(w.inputTokens + w.outputTokens)}</td>
                        <td>{formatCny(w.cost)}</td>
                        <td>{formatMs(w.elapsedMs)}</td>
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
