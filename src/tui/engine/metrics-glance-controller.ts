import type { TuiMetrics } from './app.js'

/**
 * Metrics + GlanceBar state manager — holds the 9 metrics/glance/domain state
 * fields extracted from TuiApp (W-B6). Render logic (GlanceBar composition,
 * domain resolution, cost calculation) stays in TuiApp; this class only
 * manages the state values.
 */
export type MetricsProvider = () => TuiMetrics | null

export class MetricsGlanceController {
  /** 模型上下文窗口（tokens），用于 context% */
  contextWindow?: number
  /** git 分支（启动时读取一次） */
  gitBranch?: string
  /** /domain 或 agent 自动匹配的会话星域（GlanceBar 常态显示） */
  sessionStarDomainName?: string
  /** 子代理编排期间的临时 domain override（turn 结束清除） */
  delegationDomainOverride?: { glyph: string; name: string }
  /** streaming 期间从 agent 同步星域（对齐 Ink 1Hz sync） */
  domainSyncProvider?: () => string | undefined
  /** 累计 usage（cost 估算） */
  totalUsage = { input: 0, output: 0, cacheRead: 0, cacheCreate: 0 }
  /** 最近一轮的 cache 命中率（0-1） */
  lastCacheHitRate?: number
  /** 最近一轮的上下文占比（0-1） */
  lastContextRatio?: number
  /** 真实指标提供者（main-ansi 闭包读 ctx.session）；无则回退内部估算 */
  metricsProvider?: MetricsProvider
}
