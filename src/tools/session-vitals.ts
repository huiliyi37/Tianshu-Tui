/**
 * session_vitals tool — 会话生命体征自查。
 *
 * 模型在写"系统状态"类结论（上下文占用、缓存命中、信号台账）前有处取证，
 * 替代凭感觉脑补。只读、零副作用；数据全部来自运行时内存态，无磁盘 IO。
 *
 * 空虚真值纪律：拿不到的数据显式标注"无数据"，绝不编数字。
 */
import type { Tool, ToolCallParams, ToolResult } from './types.js'
import type { RuntimeSelfModel } from '../agent/runtime-self-model.js'

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
  /** Read-only orchestration self-model; absent in worker/non-agent contexts. */
  runtime?: RuntimeSelfModel | null
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
  lines.push('')
  lines.push('## 运行时自模型')
  if (!v.runtime) {
    lines.push('- 无数据（协调器未挂接或当前为 worker 上下文）')
  } else {
    const r = v.runtime
    const phase = r.phase ? ` phase=${r.phase}` : ''
    lines.push(`- health=${r.health} attention=${r.attention}${phase} confidence=${r.confidence.toFixed(2)}`)
    lines.push(`- workers=${r.activeWorkers}/${r.maxWorkers} pending=${r.pendingWorkers} stalled=${r.stalledWorkers} fileScopes=${r.inFlightFileScopes} claims=${r.activeClaims}`)
    lines.push(`- providerDegradation=${pct(r.providerDegradation)} contextPressure=${pct(r.contextPressure)} verificationDebt=${pct(r.verificationDebt)}`)
    if (r.signals.length === 0) {
      lines.push('- signals=none')
    } else {
      for (const signal of r.signals.slice(0, 5)) {
        lines.push(`- signal ${signal.kind} [${signal.attention}] score=${signal.score.toFixed(2)}: ${signal.reason}`)
      }
    }
  }
  return lines.join('\n')
}

export function createSessionVitalsTool(getVitals: () => SessionVitalsData | null): Tool {
  return {
    definition: {
      name: 'session_vitals',
      description: `本会话运行时生命体征的只读快照：上下文占用（精确 token 数 + 窗口大小）、近期缓存命中数据、sensorium 各维度、CVM 开销/节流状态，以及 advisory 台账。

### 何时调用
在对会话自身状态下任何结论之前调用——上下文压力、缓存行为、信号噪声。引用这里的数字，不要凭感觉猜。诊断系统 advisory 为何反复触发时也可用。

### 输出
紧凑 markdown。没有数据的字段会显式标注「无数据」——绝不编造。`,
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
