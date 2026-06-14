/**
 * T9 格式化函数 — GlanceBar 状态栏。
 *
 * 纯函数，从 `glance-bar.tsx` 的渲染逻辑提取。
 * 单行 ANSI 格式化，包含 4 个 zone。
 */

import { STAR_DOMAINS } from '../../agent/star-domain.js'
import { starDomainRegistry } from '../../agent/star-domain-registry.js'
import { color } from '../engine/ansi.js'
import stringWidth from 'string-width'
import type { RivetTheme } from '../theme.js'

/** 星域名称 → GlanceBar 展示（glyph + 中文名），对齐 Ink glance-bar.tsx findDomain。 */
export function resolveStarDomainDisplay(domainName: string | undefined): { glyph: string; name: string } | null {
  if (!domainName) return null
  for (const [id, domain] of Object.entries(STAR_DOMAINS)) {
    if (domain.name === domainName || id === domainName) {
      return { glyph: domain.uiPersona.glyph, name: domain.name }
    }
  }
  const custom = starDomainRegistry.list().find(d => d.name === domainName || d.id === domainName)
  if (custom) return { glyph: '◇', name: custom.name }
  return { glyph: '☆', name: domainName }
}

export interface GlanceBarInput {
  /** 终端宽度 */
  width: number
  /** 当前星域标识 */
  domainGlyph?: string
  domainName?: string
  /** Git 分支名 */
  branch?: string
  /** 阶段标识（glyph） */
  phaseGlyph?: string
  phaseLabel?: string
  /** 模型名称 */
  modelName?: string
  /** 推理 effort glyph */
  reasoningEffort?: string
  /** 缓存命中率 0-1 */
  cacheHitRate?: number
  /** 上下文占比 0-1 */
  contextRatio?: number
  /** 估算已用 token（用于 ◧ Xk/Yk 显示，对齐 Ink） */
  estimatedTokens?: number
  /** 模型上下文窗口 token 上限（与 estimatedTokens 配套） */
  maxTokens?: number
  /** 本轮费用（美元） */
  cost?: number
  /** 已用时间（毫秒） */
  elapsedMs?: number
  /** 是否窄终端（< 60 列） */
  narrow?: boolean
  /** 会话序号 */
  turnCount?: number
}

/**
 * 格式化 GlanceBar 为单行 ANSI 字符串。
 *
 * Zone 布局：domain ┃ phase ┃ model cache tokens ┃ … elapsed
 */
export function formatGlanceBar(input: GlanceBarInput, theme: RivetTheme): string {
  const narrow = input.narrow ?? input.width < 60

  // Zone 1: Domain identity — muted (NOT primary/gold). 95% 墨灰.
  const domainGlyph = input.domainGlyph ?? '❂'
  const domainLabel = input.domainName ?? '天枢'
  const branchPart = !narrow && input.branch ? ` (${input.branch})` : ''
  const zone1 = `${color(domainGlyph, theme.muted)} ${color(domainLabel, theme.muted)}${color(branchPart, theme.dim)}`

  // Zone 2: Phase — glyph uses primary (ziwei, the ONE accent); label muted.
  // 五行符号（◐✦⚙▲❧）是状态栏唯一的彩色亮点。
  let zone2Glyph = ''
  let zone2Label = ''
  if (input.phaseGlyph) {
    zone2Glyph = color(input.phaseGlyph, theme.primary)
    zone2Label = color(input.phaseLabel || '候待', theme.muted)
  }
  const zone2 = `${zone2Glyph} ${zone2Label}`.trim()

  // Zone 3: Model + Cache + Tokens — all muted/dim, dot-separated for breathing room
  const parts: string[] = []
  if (input.modelName) {
    parts.push(color(narrow ? input.modelName.slice(0, 12) : input.modelName, theme.muted))
  }
  if (input.reasoningEffort) {
    parts.push(color(input.reasoningEffort, theme.dim))
  }
  if (input.cacheHitRate !== undefined) {
    const cachePct = (input.cacheHitRate * 100).toFixed(0)
    // 始终显示缓存命中率，0% 用 dim 而非隐藏，避免用户误判为"未接入"
    parts.push(color(`⚡${cachePct}%`, input.cacheHitRate > 0 ? theme.success : theme.dim))
  }
  if (input.contextRatio !== undefined) {
    const pct = Math.round(input.contextRatio * 100)
    // < 1% 也显示具体值，避免用户看到 ctx 0% 误以为数据未接入
    const pctDisplay = pct === 0 && input.contextRatio > 0 ? '<1%' : `${pct}%`
    const ratioColor = pct >= 88 ? theme.error : pct >= 75 ? theme.warning : theme.dim
    const compactWarn = pct >= 78 ? ' ⚠compact' : ''
    parts.push(color(`ctx ${pctDisplay}${compactWarn}`, ratioColor))
  }
  if (!narrow && input.estimatedTokens !== undefined && input.maxTokens && input.maxTokens > 0) {
    parts.push(color(`◧ ${formatTokensK(input.estimatedTokens)}/${formatTokensK(input.maxTokens)}`, theme.dim))
  }
  if (input.cost !== undefined && input.cost > 0) {
    parts.push(color(`$${input.cost.toFixed(2)}`, theme.dim))
  }
  const dotSep = color(' · ', theme.dim)
  const zone3 = parts.join(dotSep)

  // Zone 4: Elapsed
  let zone4 = ''
  if (input.elapsedMs !== undefined) {
    zone4 = formatElapsed(input.elapsedMs)
  }
  zone4 = color(zone4, theme.dim)

  // ── Assembly — 双 cluster 左右分布 ──────────────────────
  // 左 cluster: identity + phase    右 cluster: metrics + elapsed
  // 中间用空格撑满终端宽度，呼吸感拉满

  const leftParts: string[] = [zone1]
  if (zone2) leftParts.push(zone2)
  const left = leftParts.join('  ')

  // Build right cluster items for progressive truncation
  const rightItems: string[] = []
  if (zone3) rightItems.push(zone3)
  if (zone4) rightItems.push(zone4)
  const rightSep = '  '

  // Truncate right cluster if left + right exceeds terminal width
  const leftLen = stripAnsiLen(left)
  const maxRight = input.width - 1 - leftLen - 4  // 4 = min gap
  let right = ''
  let accumulated = 0
  for (const item of rightItems) {
    const itemLen = stripAnsiLen(item)
    const addLen = accumulated > 0 ? rightSep.length + itemLen : itemLen
    if (accumulated + addLen <= maxRight) {
      right = accumulated > 0 ? right + rightSep + item : item
      accumulated += addLen
    } else {
      break
    }
  }

  const gap = Math.max(4, input.width - 1 - leftLen - stripAnsiLen(right))

  return `${left}${' '.repeat(gap)}${right}`
}

function stripAnsiLen(s: string): number {
  // 必须用 display width（非 .length）：CJK(天枢)/全角符号每字符占 2 列但 .length 计 1。
  // 用 .length 会让 padding/截断欠估 → 状态行被撑到 ≥ 终端宽度 → 末列自动换行 →
  // LiveEngine 行数计算与终端实际换行错位 → clear() 欠擦 → chrome 残留进 scrollback(重复渲染)。
  return stringWidth(s.replace(/\x1B\[[0-9;]*[a-zA-Z]/g, ''))
}

/** token 计数压缩为可读单位：
 *  - < 1k   → 原值（"850"）
 *  - < 1M   → 取整 k（"12k"、"200k"）
 *  - ≥ 1M   → 一位小数 M（"1.0M"、"2.5M"，≥10M 改取整以避免视觉过宽）
 *  把 "1000k" 这类宽度怪物压成 "1.0M" 是领航星 2026-06-11 在 T9 GlanceBar 上的
 *  实测诉求——1M 窗口下原显示宽度把 GlanceBar 顶到换行临界。 */
function formatTokensK(n: number): string {
  if (n >= 1_000_000) {
    const m = n / 1_000_000
    return m >= 10 ? `${Math.round(m)}M` : `${m.toFixed(1)}M`
  }
  if (n >= 1000) return `${Math.round(n / 1000)}k`
  return `${n}`
}

function formatElapsed(ms: number): string {
  if (ms < 60000) return `${Math.floor(ms / 1000)}s`
  const mins = Math.floor(ms / 60000)
  const secs = Math.floor((ms % 60000) / 1000)
  return `${mins}m${secs}s`
}
