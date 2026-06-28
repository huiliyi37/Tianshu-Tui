/**
 * T9 格式化函数 — slash 命令提示。
 *
 * 从 slash-hint.tsx / command-palette.tsx 提取过滤逻辑为纯函数。
 * 零 React/Ink 依赖。
 *
 * 渲染结构（live 区，输入以 `/` 开头时）：
 *   ❯ /help — Show all commands
 *     /compact — Compact conversation context
 *   … 3 more · tab to complete
 */

import { color } from '../engine/ansi.js'
import type { RivetTheme } from '../theme.js'

export interface SlashHintEntry {
  name: string
  description: string
}

export const SLASH_HINT_MAX_VISIBLE = 5

type ScoredEntry = { entry: SlashHintEntry; score: number }

/**
 * 过滤并按相关性排序命令。
 *
 * 排序优先级（score 越小越靠前）：
 *   0 = name 前缀匹配（如 "revi" → /review）
 *   1 = name 子串匹配（如 "ewi" → /review）
 *   2 = name 有序子序列 fuzzy（如 "rvw" → /review）
 *   3 = description 子串匹配
 *
 * 同分时保持原始顺序（stable sort）。
 */
export function filterSlashCommands(commands: readonly SlashHintEntry[], query: string): SlashHintEntry[] {
  if (!query) return [...commands]
  const lower = query.toLowerCase()
  const scored: ScoredEntry[] = []
  for (const c of commands) {
    // Strip leading "/" for matching — query is already slash-stripped
    const name = c.name.toLowerCase().replace(/^\//, '')
    const desc = c.description.toLowerCase()
    let score: number | null = null
    if (name.startsWith(lower)) {
      score = 0
    } else if (name.includes(lower)) {
      score = 1
    } else {
      // name fuzzy: ordered subsequence
      let qi = 0
      for (let i = 0; i < name.length && qi < lower.length; i++) {
        if (name[i] === lower[qi]) qi++
      }
      if (qi === lower.length) score = 2
    }
    if (score === null && desc.includes(lower)) score = 3
    if (score !== null) scored.push({ entry: c, score })
  }
  scored.sort((a, b) => a.score - b.score)
  return scored.map(s => s.entry)
}

export interface FormatSlashHintInput {
  /** 当前输入（以 `/` 开头） */
  input: string
  /** 全部可用命令 */
  commands: readonly SlashHintEntry[]
  /** 当前选中项（Tab 补全目标），默认 0 */
  selectedIdx?: number
  /** 最大显示条数 */
  maxVisible?: number
}

/**
 * 格式化 slash 提示为 ANSI 行数组。无匹配时返回空数组。
 */
export function formatSlashHint(input: FormatSlashHintInput, theme: RivetTheme): string[] {
  if (!input.input.startsWith('/')) return []
  const query = input.input.slice(1)
  const filtered = filterSlashCommands(input.commands, query)
  if (filtered.length === 0) return []
  const maxVisible = input.maxVisible ?? SLASH_HINT_MAX_VISIBLE
  const selectedIdx = Math.min(input.selectedIdx ?? 0, filtered.length - 1)

  // Scroll window: follow the selected index so ↑↓ navigation always keeps
  // the cursor visible. Inspired by Claude Code's command palette scrolling.
  let scrollOffset = 0
  if (filtered.length > maxVisible) {
    if (selectedIdx < maxVisible) {
      // Near top — show from beginning
      scrollOffset = 0
    } else if (selectedIdx >= filtered.length - maxVisible) {
      // Near bottom — pin to end
      scrollOffset = filtered.length - maxVisible
    } else {
      // Middle — center the selection
      scrollOffset = selectedIdx - Math.floor(maxVisible / 2)
    }
  }

  const visible = filtered.slice(scrollOffset, scrollOffset + maxVisible)
  const overflowAbove = scrollOffset
  const overflowBelow = filtered.length - scrollOffset - visible.length

  const lines: string[] = []

  // Scroll indicator: show "↑ N above" when scrolled past top
  if (overflowAbove > 0) {
    lines.push(color(`  ↑ ${overflowAbove} more above`, theme.dim))
  }

  for (let i = 0; i < visible.length; i++) {
    const cmd = visible[i]!
    const globalIdx = scrollOffset + i
    const selected = globalIdx === selectedIdx
    const marker = selected ? color('❯ ', theme.primary) : '  '
    const name = color(cmd.name, selected ? theme.primary : theme.secondary, { bold: selected })
    const desc = color(` — ${cmd.description}`, theme.muted)
    lines.push(`${marker}${name}${desc}`)
  }

  // Scroll indicator: show "↓ N below" when more items remain
  const footerParts: string[] = []
  if (overflowBelow > 0) {
    footerParts.push(`↓ ${overflowBelow} more`)
  }
  footerParts.push('↑↓ navigate', 'tab complete', '↵ run')
  lines.push(color(`  ${footerParts.join(' · ')}`, theme.dim))
  return lines
}

/** Tab 补全目标：过滤结果中的选中项（无匹配返回 null） */
export function slashCompletionTarget(input: string, commands: readonly SlashHintEntry[], selectedIdx = 0): string | null {
  if (!input.startsWith('/')) return null
  const filtered = filterSlashCommands(commands, input.slice(1))
  if (filtered.length === 0) return null
  return filtered[Math.min(selectedIdx, filtered.length - 1)]!.name
}
