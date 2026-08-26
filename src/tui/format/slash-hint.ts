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
 * 同分时按 mruRank（可选）降序——最近使用优先；未提供或均未命中保持
 * 原始顺序（stable sort）。mruRank 键为去 `/` 前缀的命令名。
 */
export function filterSlashCommands(
  commands: readonly SlashHintEntry[],
  query: string,
  mruRank?: ReadonlyMap<string, number>,
): SlashHintEntry[] {
  const mruFirst = <T extends { name: string }>(entries: T[]): T[] => {
    if (mruRank === undefined) return entries
    return [...entries].sort(
      (a, b) =>
        (mruRank.get(b.name.replace(/^\//, '')) ?? 0) -
        (mruRank.get(a.name.replace(/^\//, '')) ?? 0),
    )
  }
  if (!query) {
    // 空 query（输入恰好 `/`）：只展示核心层。全量 65+ 条按定义序浏览对普通
    // 用户是噪音墙，常用命令被淹没；核心层（~20 条高频）+ footer 引导后，
    // 多打一个字符即过滤全量，Ctrl+P 面板永远全量——分层只影响发现性，
    // 不删任何命令。清单无 core 标注（如纯 skills 形态）时回退全量。
    // 键导航 / Tab 补全 / 渲染三处共用本函数，分层在此单点生效即整体一致。
    const core = commands.filter(c => c.tier === 'core')
    return mruFirst(core.length > 0 ? core : [...commands])
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
  scored.sort((a, b) => {
    const scoreDiff = a.score - b.score
    if (scoreDiff !== 0) return scoreDiff
    // 同分：MRU 命中优先（rank 高 = 最近使用）；未提供 mruRank 时保持稳定序
    if (mruRank === undefined) return 0
    return (
      (mruRank.get(b.entry.name.replace(/^\//, '')) ?? 0) -
      (mruRank.get(a.entry.name.replace(/^\//, '')) ?? 0)
    )
  })
  return scored.map(s => s.entry)
}

export interface FormatSlashHintInput {
  /** 当前输入（以 `/` 开头） */
  input: string
  /** 全部可用命令 */
  commands: readonly SlashHintEntry[]
  /** 当前选中项（Tab 补全目标），默认 0 */
  selectedIdx?: number
  /** 最大显示条数（预算钳制透传） */
  maxVisible?: number
  /** 预算不足时隐藏 footer 行（透传，TUI 钉底） */
  hideFooter?: boolean
}

/** formatSlashMenu 输入：已过滤已排序的命令列表（由调用方保证顺序）。 */
export interface FormatSlashMenuInput {
  /** 已过滤列表（MRU 排序等由调用方完成） */
  items: readonly SlashHintEntry[]
  /** 当前选中项下标（越界 clamp 到合法范围） */
  selected: number
  /** 最大显示条数 */
  maxVisible?: number
  /** footer 中间插入的提示段（如核心层说明）；缺省不占位 */
  footerNote?: string
  /** 预算不足时隐藏 footer 行（TUI 钉底：菜单高度钳制到输入框上方可用空间） */
  hideFooter?: boolean
}

/** 菜单高度钳制结果：可见项数 + 是否隐藏 footer。 */
export interface SlashMenuBudget {
  visibleItems: number
  hideFooter: boolean
}

/**
 * 计算 slash 菜单可见项数（TUI 钉底）：
 * 预算 = maxRows - chromeRows - inputRows（输入框上方可用 display rows）。
 * - 预算 ≥ 2：visibleItems = min(design, budget-1)（留 footer 行）
 * - 预算 = 1：1 项无 footer（最少可见反馈）
 * - 预算 ≤ 0：菜单不显示（钉底优先——宁可无菜单也不超行触发终端滚动，
 *   输入框位置跳动正是「宁可超行也不能让输入框消失」路径的根因）
 */
export function computeSlashMenuBudget(opts: {
  chromeRows: number
  inputRows: number
  maxRows: number
  designMaxVisible: number
}): SlashMenuBudget {
  const budget = opts.maxRows - opts.chromeRows - opts.inputRows
  if (budget <= 0) return { visibleItems: 0, hideFooter: true }
  if (budget === 1) return { visibleItems: 1, hideFooter: true }
  return {
    visibleItems: Math.max(1, Math.min(opts.designMaxVisible, budget - 1)),
    hideFooter: false,
  }
}

/**
 * 格式化 slash 命令菜单为 ANSI 行数组——纯渲染，不做过滤/排序。
 * 输入为空列表返回空数组。
 */
export function formatSlashMenu(input: FormatSlashMenuInput, theme: RivetTheme): string[] {
  const items = input.items
  if (items.length === 0) return []
  const maxVisible = input.maxVisible ?? SLASH_HINT_MAX_VISIBLE
  const selectedIdx = Math.min(Math.max(input.selected, 0), items.length - 1)

  // Scroll window: follow the selected index so ↑↓ navigation always keeps
  // the cursor visible. Inspired by Claude Code's command palette scrolling.
  let scrollOffset = 0
  if (items.length > maxVisible) {
    if (selectedIdx < maxVisible) {
      // Near top — show from beginning
      scrollOffset = 0
    } else if (selectedIdx >= items.length - maxVisible) {
      // Near bottom — pin to end
      scrollOffset = items.length - maxVisible
    } else {
      // Middle — center the selection
      scrollOffset = selectedIdx - Math.floor(maxVisible / 2)
    }
  }

  const visible = items.slice(scrollOffset, scrollOffset + maxVisible)
  const overflowAbove = scrollOffset
  const overflowBelow = items.length - scrollOffset - visible.length

  const lines: string[] = []

  for (let i = 0; i < visible.length; i++) {
    const cmd = visible[i]!
    const globalIdx = scrollOffset + i
    const selected = globalIdx === selectedIdx
    const marker = selected ? color('❯ ', theme.primary) : '  '
    const name = color(cmd.name, selected ? theme.primary : theme.secondary, { bold: selected })
    const desc = color(` — ${cmd.description}`, theme.muted)
    lines.push(`${marker}${name}${desc}`)
  }

  // Scroll indicators + navigation hints 全部并入 footer 单行——菜单总行数恒为
  // visibleItems + (footer?1:0)，与预算数学闭合（↑ 独立行曾使滚动时输出超预算 1 行，
  // 整帧超 maxRows → 终端滚动 → 输入框跳动，TUI 钉底审查 F1 变体）。
  const footerParts: string[] = []
  if (!input.hideFooter) {
    if (overflowAbove > 0) {
      footerParts.push(`↑ ${overflowAbove} more above`)
    }
    if (overflowBelow > 0) {
      footerParts.push(`↓ ${overflowBelow} more`)
    }
    if (input.footerNote !== undefined && input.footerNote !== '') {
      footerParts.push(input.footerNote)
    }
    footerParts.push('↑↓ navigate', 'tab complete', '↵ run')
    lines.push(color(`  ${footerParts.join(' · ')}`, theme.dim))
  }
  return lines
}

/**
 * 格式化 slash 提示为 ANSI 行数组。无匹配时返回空数组。
 * 过滤（filterSlashCommands）+ 格式化（formatSlashMenu）的组合；
 * 空 query 时追加核心层提示段。
 */
export function formatSlashHint(input: FormatSlashHintInput, theme: RivetTheme): string[] {
  if (!input.input.startsWith('/')) return []
  const query = input.input.slice(1)
  const filtered = filterSlashCommands(input.commands, query)
  if (filtered.length === 0) return []
  // 空 query = 核心层视图：给出「还有更多」的明确出口，否则用户不知道
  // 进阶命令的存在（65+ 条只露 20 条，发现性反而变差）。
  const coreHint = !query && input.commands.length > filtered.length
    ? `核心 ${filtered.length}/${input.commands.length} · 输入即过滤全部 · ctrl+p 面板`
    : undefined
  return formatSlashMenu({
    items: filtered,
    selected: input.selectedIdx ?? 0,
    maxVisible: input.maxVisible,
    footerNote: coreHint,
    hideFooter: input.hideFooter,
  }, theme)
}

/** Tab 补全目标：过滤结果中的选中项（无匹配返回 null） */
export function slashCompletionTarget(input: string, commands: readonly SlashHintEntry[], selectedIdx = 0): string | null {
  if (!input.startsWith('/')) return null
  const filtered = filterSlashCommands(commands, input.slice(1))
  if (filtered.length === 0) return null
  return filtered[Math.min(selectedIdx, filtered.length - 1)]!.name
}
