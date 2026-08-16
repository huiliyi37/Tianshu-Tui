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
  /** 可选参数提示（ghost text，P3）：输入精确匹配「命令名+空格」时在光标后
   *  暗色提示（如 /effort → 'off|low|medium|high|max'）。纯渲染层拼接，不进 buffer。 */
  argsHint?: string
  /** 核心层标记（见 command-palette.ts PaletteCommand.tier）：空 query 的
   *  提示列表只展示核心层。skills 动态条目不带此标记 → 进阶层。 */
  tier?: 'core'
}

/**
 * ghost text 匹配（P3-2）：输入为「/命令名 + 恰好一个空白」形态时返回该命令的
 * argsHint；否则 null。
 *
 * 只在命令名已完整后出现——继续输入参数（第二个非空白字符）即失配，由调用方
 * 每帧重算自然消失。不做前缀/模糊匹配；多行输入（含 \n）直接排除。
 */
export function slashArgsHint(commands: readonly SlashHintEntry[], value: string): string | null {
  if (!value.startsWith('/') || value.includes('\n')) return null
  const m = value.match(/^(\/\S+)\s$/)
  if (!m) return null
  const typed = m[1]!.toLowerCase()
  for (const c of commands) {
    if (!c.argsHint) continue
    if (c.name.toLowerCase() === typed) return c.argsHint
  }
  return null
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
  if (!query) {
    // 空 query（输入恰好 `/`）：只展示核心层。全量 65+ 条按定义序浏览对普通
    // 用户是噪音墙，常用命令被淹没；核心层（~20 条高频）+ footer 引导后，
    // 多打一个字符即过滤全量，Ctrl+P 面板永远全量——分层只影响发现性，
    // 不删任何命令。清单无 core 标注（如纯 skills 形态）时回退全量。
    // 键导航 / Tab 补全 / 渲染三处共用本函数，分层在此单点生效即整体一致。
    const core = commands.filter(c => c.tier === 'core')
    return core.length > 0 ? core : [...commands]
  }
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
  // 空 query = 核心层视图：给出「还有更多」的明确出口，否则用户不知道
  // 进阶命令的存在（65+ 条只露 20 条，发现性反而变差）。
  if (!query && input.commands.length > filtered.length) {
    footerParts.push(`核心 ${filtered.length}/${input.commands.length} · 输入即过滤全部 · ctrl+p 面板`)
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
