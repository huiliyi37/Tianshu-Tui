/**
 * session_vitals tool — 会话生命体征自查（W5，incident 20b9714e）。
 *
 * 模型在写"系统状态"类结论（上下文占用、缓存命中、信号台账）前有处取证，
 * 替代凭感觉脑补。只读、零副作用；数据全部来自运行时内存态，无磁盘 IO。
 *
 * 空虚真值纪律：拿不到的数据显式标注"无数据"，绝不编数字。
 */
import type { Tool, ToolCallParams, ToolResult } from './types.js'

/** 运行时提供给工具的生命体征快照（AgentLoop.getSessionVitals 的返回形状） */
export interface SessionVitalsData {
  ctx: { estimatedTokens: number; contextWindow: number; ratio: number }
  /** 近 5 轮缓存记录（cacheRead / cacheCreation 来自 API usage 回报） */
  cache: Array<{ turn: number; cacheRead: number; cacheCreation: number }>
  sensorium: {
    momentum: number; pressure: number; confidence: number
    complexity: number; freshness: number; stability?: number
  } | null
  cvm: { overheadRatio: number; throttled: boolean; ceiling: boolean }
  advisories: {
    rendered: number; dropped: number; adopted: number; ignored: number
    /** delivered 降序 top5 */
    top: Array<{ key: string; delivered: number; adopted: number; ignored: number; silenced: boolean }>
  }
  turn: number
}

function pct(v: number): string {
  return `${(v * 100).toFixed(1)}%`
}

export function formatVitals(v: SessionVitalsData): string {
  const lines: string[] = []
  lines.push(`# session vitals（turn ${v.turn}，运行时内存态实测）`)
  lines.push('')
  lines.push(`## 上下文`)
  lines.push(`- 占用 ${v.ctx.estimatedTokens.toLocaleString()} / ${v.ctx.contextWindow.toLocaleString()} token（${pct(v.ctx.ratio)}）`)
  lines.push('')
  lines.push('## 缓存（近 5 轮，API usage 回报）')
  if (v.cache.length === 0) {
    lines.push('- 无数据（尚无带 usage 的 API 轮次）')
  } else {
    for (const c of v.cache) {
      const denom = c.cacheRead + c.cacheCreation
      const rate = denom > 0 ? pct(c.cacheRead / denom) : 'n/a'
      lines.push(`- turn ${c.turn}: read=${c.cacheRead.toLocaleString()} create=${c.cacheCreation.toLocaleString()} 命中≈${rate}`)
    }
  }
  lines.push('')
  lines.push('## sensorium')
  if (!v.sensorium) {
    lines.push('- 无数据（感知层未运行）')
  } else {
    const s = v.sensorium
    const r2 = (x: number | undefined) => x === undefined ? 'n/a' : x.toFixed(2)
    lines.push(`- momentum=${r2(s.momentum)} pressure=${r2(s.pressure)} confidence=${r2(s.confidence)} complexity=${r2(s.complexity)} freshness=${r2(s.freshness)} stability=${r2(s.stability)}`)
  }
  lines.push('')
  lines.push('## CVM 开销')
  lines.push(`- overheadRatio=${pct(v.cvm.overheadRatio)}（增量计费口径）· throttled=${v.cvm.throttled} · ceiling=${v.cvm.ceiling}`)
  lines.push('')
  lines.push('## advisory 台账（会话累计）')
  lines.push(`- rendered=${v.advisories.rendered} dropped=${v.advisories.dropped} adopted=${v.advisories.adopted} ignored=${v.advisories.ignored}`)
  if (v.advisories.top.length > 0) {
    for (const t of v.advisories.top) {
      lines.push(`- ${t.key}: delivered=${t.delivered} adopted=${t.adopted} ignored=${t.ignored}${t.silenced ? ' [已静默]' : ''}`)
    }
  }
  return lines.join('\n')
}

export function createSessionVitalsTool(getVitals: () => SessionVitalsData | null): Tool {
  return {
    definition: {
      name: 'session_vitals',
      description: `Read-only snapshot of this session's runtime vitals: context usage (exact tokens + window), recent cache hit data, sensorium dimensions, CVM overhead/throttle state, and the advisory ledger.

### When to call
Before making any claim about the session's own state — context pressure, cache behavior, signal noise. Cite these numbers instead of guessing. Also useful when diagnosing why system advisories keep firing.

### Output
Compact markdown. Fields without data are explicitly marked 无数据 — never fabricated.`,
      input_schema: {
        type: 'object',
        properties: {},
        required: [],
      },
    },

    async execute(_params: ToolCallParams): Promise<ToolResult> {
      const vitals = getVitals()
      if (!vitals) {
        return { content: 'session vitals 不可用：当前上下文没有挂接运行时（例如 worker 子会话）。', isError: false }
      }
      return { content: formatVitals(vitals) }
    },

    isConcurrencySafe: () => true,
    isEnabled: () => true,
    requiresApproval: () => false,
  }
}
