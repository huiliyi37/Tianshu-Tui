/**
 * T9 格式化函数 — GlanceBar 状态栏。
 *
 * 纯函数，从 `glance-bar.tsx` 的渲染逻辑提取。
 * 单行 ANSI 格式化，包含 4 个 zone。
 */

import { ANSI, color } from '../engine/ansi.js'
import stringWidth from 'string-width'
import type { RivetTheme } from '../theme.js'

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

  // Zone 1: Domain identity
  const domainGlyph = input.domainGlyph ?? '❂'
  const domainLabel = input.domainName ?? '天枢'
  const branchPart = !narrow && input.branch ? ` (${input.branch})` : ''
  const zone1 = `${color(domainGlyph, theme.primary, { bold: true })} ${color(domainLabel, theme.primary)}${color(branchPart, theme.dim)}`

  // Zone 2: Phase
  let zone2 = ''
  if (input.phaseGlyph) {
    zone2 = `${input.phaseGlyph} ${input.phaseLabel ?? ''}`
  }
  zone2 = color(zone2, theme.secondary)

  // Zone 3: Model + Cache + Tokens
  const parts: string[] = []
  if (input.modelName) {
    parts.push(narrow ? input.modelName.slice(0, 12) : input.modelName)
  }
  if (input.reasoningEffort) {
    parts.push(input.reasoningEffort)
  }
  if (input.cacheHitRate !== undefined && input.cacheHitRate > 0) {
    parts.push(`⚡${(input.cacheHitRate * 100).toFixed(0)}%`)
  }
  if (input.contextRatio !== undefined) {
    const pct = Math.round(input.contextRatio * 100)
    // ≥78% 显示 compact 警告（对齐 Claude Code 的 "Context left until auto-compact"）
    const ratioColor = pct >= 88 ? theme.error : pct >= 78 ? theme.warning : theme.primary
    const compactWarn = pct >= 78 ? ' ⚠compact' : ''
    parts.push(color(`ctx ${pct}%${compactWarn}`, ratioColor))
  }
  if (!narrow && input.estimatedTokens !== undefined && input.maxTokens && input.maxTokens > 0) {
    parts.push(color(`◧ ${formatTokensK(input.estimatedTokens)}/${formatTokensK(input.maxTokens)}`, theme.dim))
  }
  if (input.cost !== undefined && input.cost > 0) {
    parts.push(`$${input.cost.toFixed(2)}`)
  }
  const zone3 = parts.join(' ')

  // Zone 4: Elapsed
  let zone4 = ''
  if (input.elapsedMs !== undefined) {
    zone4 = formatElapsed(input.elapsedMs)
  }
  zone4 = color(zone4, theme.dim)

  // ── Assembly ────────────────────────────────────────────────
  const sep = ` ${color('┃', theme.dim)} `

  // Calculate available width for zone3 (flex zone)
  const prefixLen = stripAnsiLen(`${zone1}${sep}${zone2}${sep}`)
  const suffixLen = stripAnsiLen(`${sep}${zone4}`)
  const maxZone3 = Math.max(10, input.width - prefixLen - suffixLen - 2)

  let zone3Clipped = zone3
  if (stripAnsiLen(zone3) > maxZone3) {
    // Truncate zone3
    let accumulated = 0
    const truncatedParts: string[] = []
    for (const p of parts) {
      const plen = stripAnsiLen(p) + 1 // +1 for space
      if (accumulated + plen <= maxZone3) {
        truncatedParts.push(p)
        accumulated += plen
      } else {
        break
      }
    }
    zone3Clipped = truncatedParts.join(' ')
  }

  // Right-pad zone4
  const totalLen = stripAnsiLen(`${zone1}${sep}${zone2}${sep}${zone3Clipped}${sep}${zone4}`)
  const padding = Math.max(0, input.width - totalLen - 1)
  zone4 = ' '.repeat(padding) + zone4

  // Separator line above
  const sepLine = color('─'.repeat(Math.max(1, input.width - 1)), theme.dim)

  return `${sepLine}\n${zone1}${sep}${zone2}${sep}${zone3Clipped}${sep}${zone4}`
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
