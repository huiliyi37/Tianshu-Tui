/**
 * session-performance.ts — 单会话性能视图的纯解析/聚合（W-stats）。
 *
 * 直读 `<sid>/cache-log.jsonl` 的内容，折叠轮级 TTFT/输出速度/命中率，
 * 供 `GET /sessions/:id/performance`（轮尾注回放补数据、Insights 会话下钻）
 * 消费。行语义同 usage-aggregator：主轮行无 `event` 字段，侧路/决策行跳过。
 */

export interface SessionPerformanceTurn {
  turn: number
  t: number
  model: string
  ttftMs?: number
  tokensPerSecond?: number
  hitRatePct?: number
  inputTokens: number
  outputTokens: number
}

export interface SessionPerformanceSummary {
  samples: number
  ttftAvgMs?: number
  ttftP50Ms?: number
  ttftP90Ms?: number
  tpsAvg?: number
}

export interface SessionPerformanceResult {
  turns: SessionPerformanceTurn[]
  summary: SessionPerformanceSummary
}

/** 最近秩分位数（p50 取下界，p90 取上界）——与 usage-aggregator 同规则。 */
function percentile(sorted: number[], p: number): number | undefined {
  if (sorted.length === 0) return undefined
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1))]
}

/** 行累积的共享状态——同步/异步两个解析入口共用一份逐字段语义。 */
interface PerfAccumulator {
  turns: SessionPerformanceTurn[]
  ttftSamples: number[]
  tpsSamples: number[]
}

function accumulateRecord(r: Record<string, unknown>, acc: PerfAccumulator): void {
  const input = typeof r.input === 'number' ? r.input : 0
  const cacheRead = typeof r.cacheRead === 'number' ? r.cacheRead : 0
  const ttftMs = typeof r.ttftMs === 'number' ? r.ttftMs : undefined
  const tokensPerSecond = typeof r.tps === 'number' ? r.tps : undefined
  acc.turns.push({
    turn: typeof r.turn === 'number' ? r.turn : 0,
    t: typeof r.t === 'number' ? r.t : 0,
    model: typeof r.model === 'string' && r.model ? r.model : 'unknown',
    ttftMs,
    tokensPerSecond,
    hitRatePct: input > 0 ? Math.round((cacheRead / input) * 1000) / 10 : undefined,
    inputTokens: input,
    outputTokens: typeof r.output === 'number' ? r.output : 0,
  })
  if (ttftMs !== undefined) acc.ttftSamples.push(ttftMs)
  if (tokensPerSecond !== undefined) acc.tpsSamples.push(tokensPerSecond)
}

function finalize(acc: PerfAccumulator): SessionPerformanceResult {
  acc.turns.sort((a, b) => a.turn - b.turn || a.t - b.t)
  acc.ttftSamples.sort((a, b) => a - b)
  acc.tpsSamples.sort((a, b) => a - b)
  const avg = (arr: number[]): number | undefined =>
    arr.length > 0 ? Math.round(arr.reduce((s, v) => s + v, 0) / arr.length) : undefined
  return {
    turns: acc.turns,
    summary: {
      samples: acc.ttftSamples.length,
      ttftAvgMs: avg(acc.ttftSamples),
      ttftP50Ms: percentile(acc.ttftSamples, 50),
      ttftP90Ms: percentile(acc.ttftSamples, 90),
      tpsAvg: acc.tpsSamples.length > 0
        ? Math.round((acc.tpsSamples.reduce((s, v) => s + v, 0) / acc.tpsSamples.length) * 10) / 10
        : undefined,
    },
  }
}

/** 解析并聚合 cache-log 内容。空日志/全坏行 → turns 空 + samples 0。 */
export function parseSessionPerformance(content: string): SessionPerformanceResult {
  const acc: PerfAccumulator = { turns: [], ttftSamples: [], tpsSamples: [] }
  for (const line of content.split(/\r?\n/)) {
    if (!line.trim()) continue
    try {
      const r = JSON.parse(line) as Record<string, unknown>
      if (r.event !== undefined) continue // 侧路/决策行不算轮
      accumulateRecord(r, acc)
    } catch { /* skip malformed */ }
  }
  return finalize(acc)
}

/**
 * 异步分片版本：每 chunkLines 行让出一次事件循环（setImmediate）——数 MB 的
 * cache-log 在请求线程上不再把 sidecar 的 SSE/REST 长时间饿死。逐字段语义
 * 与同步版一致；新消费方一律走本入口。
 */
export async function parseSessionPerformanceAsync(
  content: string,
  opts?: { chunkLines?: number },
): Promise<SessionPerformanceResult> {
  const chunkLines = Math.max(1, opts?.chunkLines ?? 2000)
  const acc: PerfAccumulator = { turns: [], ttftSamples: [], tpsSamples: [] }
  const lines = content.split(/\r?\n/)
  for (let i = 0; i < lines.length; i += chunkLines) {
    for (const line of lines.slice(i, i + chunkLines)) {
      if (!line.trim()) continue
      try {
        const r = JSON.parse(line) as Record<string, unknown>
        if (r.event !== undefined) continue // 侧路/决策行不算轮
        accumulateRecord(r, acc)
      } catch { /* skip malformed */ }
    }
    if (i + chunkLines < lines.length) await new Promise<void>(resolve => setImmediate(resolve))
  }
  return finalize(acc)
}
