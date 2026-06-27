/**
 * T9 格式化函数 — GlanceBar 状态栏。
 *
 * 纯函数，从 `glance-bar.tsx` 的渲染逻辑提取。
 * 单行 ANSI 格式化，包含 4 个 zone。
 */

import { STAR_DOMAINS } from '../../agent/star-domain.js'
import { starDomainRegistry } from '../../agent/star-domain-registry.js'
import { color } from '../engine/ansi.js'
import { displayWidth } from '../width.js'
import { getActiveThemeName, type RivetTheme } from '../theme.js'

/** 星域名称 → 主题语义色键（用于 input border / prompt accent 着色）。 */
export function resolveStarDomainAccent(domainName: string | undefined, theme: RivetTheme): string {
  // 单色克制：claude/antigravity/cobalt 主题下输入框边框收敛为中性 muted，不再按星域变色。
  const active = getActiveThemeName()
  if (active === 'claude' || active === 'antigravity' || active === 'cobalt') return theme.muted
  if (!domainName) return theme.muted
  for (const [id, domain] of Object.entries(STAR_DOMAINS)) {
    if (domain.name === domainName || id === domainName) {
      return theme[domain.uiPersona.accent]
    }
  }
  return theme.muted
}

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
  /** 模型名称 */
  modelName?: string
  /** 推理 effort glyph */
  reasoningEffort?: string
  /** 缓存命中率 0-1 */
  cacheHitRate?: number
  /** 上下文占比 0-1 */
  contextRatio?: number
  /** API 实际 prompt token（用于颜色阈值，反映真实窗口压力） */
  estimatedTokens?: number
  /** 可见对话消息的 token 估算（用于 ◧ Xk/Yk 显示，不含系统提示/工具） */
  conversationTokens?: number
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
  /** 是否处于 stall（无 token 超过阈值） */
  stalled?: boolean
}

export function formatGlanceLeft(input: GlanceBarInput, theme: RivetTheme): string {
  const narrow = input.narrow ?? input.width < 60
  const domainGlyph = input.domainGlyph ?? ''
  const domainLabel = input.domainName ?? '天枢'
  const branchPart = !narrow && input.branch ? ` (${input.branch})` : ''

  // 星域专属 accent 色；单色克制主题降级为 muted
  const accentColor = resolveStarDomainAccent(input.domainName, theme)

  const glyphPart = domainGlyph ? `${color(domainGlyph, accentColor)} ` : ''
  return `${glyphPart}${color(domainLabel, accentColor)}${color(branchPart, theme.dim)}`
}

export function formatGlanceRight(input: GlanceBarInput, theme: RivetTheme): string {
  const narrow = input.narrow ?? input.width < 60
  const parts: string[] = []
  if (input.modelName) {
    // 模型名属于最低层级元信息，用 dim 而不是 muted
    parts.push(color(narrow ? input.modelName.slice(0, 12) : input.modelName, theme.dim))
  }
  if (input.cacheHitRate !== undefined) {
    const cachePct = (input.cacheHitRate * 100).toFixed(0)
    const cacheColor = input.cacheHitRate < 0.5 ? theme.warning : theme.muted
    parts.push(color(`⚡${cachePct}%`, cacheColor))
  } else {
    // 无缓存数据时显示占位，避免右侧空洞或误导
    parts.push(color('⚡-', theme.dim))
  }
  const ratio = (input.estimatedTokens && input.maxTokens && input.maxTokens > 0)
    ? input.estimatedTokens / input.maxTokens : 0
  const displayTokens = input.conversationTokens !== undefined ? input.conversationTokens : input.estimatedTokens
  if (!narrow && displayTokens !== undefined && input.maxTokens && input.maxTokens > 0) {
    const tokenColor = ratio >= 0.9 ? theme.error : ratio >= 0.75 ? theme.warning : theme.muted
    parts.push(color(`◧${formatTokensK(displayTokens)}/${formatTokensK(input.maxTokens)}`, tokenColor))
  }
  if (input.cost !== undefined && input.cost > 0) {
    // cost > 0 用 secondary 高亮，让用户感知到花费
    parts.push(color(`${input.cost.toFixed(2)}`, theme.secondary))
  }
  const zone3 = parts.join('  ')

  let zone4 = ''
  if (input.elapsedMs !== undefined) {
    zone4 = formatElapsed(input.elapsedMs)
  }
  // elapsed 是基础元信息用 dim；stall 时提升到 warning 作为提示
  const elapsedPart = color(zone4, input.stalled ? theme.warning : theme.dim)

  return [zone3, elapsedPart].filter(Boolean).join('  ')
}

/**
 * 格式化 GlanceBar 为单行 ANSI 字符串。
 *
 * Zone 布局：domain ┃ model cache tokens ┃ … elapsed
 * 运行态相位已收敛到顶部 spinner 状态行（CC 对标），GlanceBar 不再重复显示。
 */
export function formatGlanceBar(input: GlanceBarInput, theme: RivetTheme): string {
  const left = formatGlanceLeft(input, theme)
  const rightFull = formatGlanceRight(input, theme)

  const leftLen = stripAnsiLen(left)
  const maxRight = input.width - 2 - leftLen - 4  // 4 = min gap
  const rightLen = stripAnsiLen(rightFull)

  let right = rightFull
  if (rightLen > maxRight) {
    // If it exceeds, we can fallback to progressive truncation
    const narrow = input.narrow ?? input.width < 60
    const parts: string[] = []
    if (input.modelName) {
      parts.push(color(narrow ? input.modelName.slice(0, 12) : input.modelName, theme.muted))
    }
    const rightSep = '  '
    let accumulated = 0
    right = ''
    for (const item of parts) {
      const itemLen = stripAnsiLen(item)
      const addLen = accumulated > 0 ? rightSep.length + itemLen : itemLen
      if (accumulated + addLen <= maxRight) {
        right = accumulated > 0 ? right + rightSep + item : item
        accumulated += addLen
      } else {
        break
      }
    }
  }

  const gap = Math.max(4, input.width - 2 - leftLen - stripAnsiLen(right))

  return `${left}${' '.repeat(gap)}${right}`
}

export function stripAnsiLen(s: string): number {
  // 必须用 display width（非 .length）：CJK(天枢)/全角符号每字符占 2 列但 .length 计 1。
  // 用 .length 会让 padding/截断欠估 → 状态行被撑到 ≥ 终端宽度 → 末列自动换行 →
  // LiveEngine 行数计算与终端实际换行错位 → clear() 欠擦 → chrome 残留进 scrollback(重复渲染)。
  // 口径须与 rowsForLine 一致（ambiguousAsWide）：星域 glyph(◇☆)/· 等在 CJK 终端按
  // 2 列渲染，narrow(stringWidth) 会欠估 → gap 偏大 → 状态行仍可能溢出折行。
  return displayWidth(s, { ambiguousAsWide: true })
}

/** token 用量进度条：0-1 比例 → 10 格填充条 + 百分比，按水位变色（≥90% error / ≥75% warning）。
 *  侧边面板（side-panel.ts）的「Token 仪表」使用。曾随双行 GlanceBar 特性引入，后该特性
 *  被 revert，但 side-panel 仍依赖此独立函数——此处单独保留它，不复活被 revert 的双行逻辑。 */
export function formatTokenProgressBar(ratio: number, theme: RivetTheme): string {
  const r = Math.max(0, Math.min(1, ratio))
  const filled = Math.round(r * 10)
  const empty = 10 - filled
  const barColor = r >= 0.9 ? theme.error : r >= 0.75 ? theme.warning : theme.dim
  const fillChar = r >= 0.9 ? '▇' : r >= 0.75 ? '▆' : '▅'
  const bar = color(fillChar.repeat(filled), barColor) + color('░'.repeat(empty), theme.dim)
  const pct = color(`${(r * 100).toFixed(0)}%`, barColor)
  return `${bar} ${pct}`
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
