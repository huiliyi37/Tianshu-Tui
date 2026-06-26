/**
 * Collapsed Read+Search Group — 将连续探索型工具调用折叠为单行摘要。
 *
 * read_file / grep / glob / repo_map / semantic_search 等探索型工具
 * 在连续调用时合并为一个组。非探索型工具（write / edit / bash / delegate）
 * 到达时打断组并 flush 到 scrollback。
 *
 * 温跃层设计：
 *   CollapsedReadSearchBuffer（状态管理）↔ app.ts（事件驱动）
 *   formatCollapsedGroup（scrollback 渲染）↔ formatCollapsedGroupLive（live 聚合）
 */

import { color } from '../engine/ansi.js'
import type { RivetTheme } from '../theme.js'

// ── Types ──────────────────────────────────────────────────────

export type CollapsibleKind = 'read' | 'search' | 'list'

export interface CollapsedReadSearchEntry {
  /** tool_use_id — 唯一标识，并行结果绑定的关键 */
  id: string
  toolName: string
  input: Record<string, unknown>
  displayName: string
  kind: CollapsibleKind
  content?: string
  isError?: boolean
  /** terminal result 已到达 */
  completed: boolean
}

export interface CollapsedReadSearchGroup {
  entries: CollapsedReadSearchEntry[]
  startMs: number
}

// ── Classification ─────────────────────────────────────────────

/**
 * 工具是否可折叠进 read+search 统一组。
 *
 * 覆盖范围（对齐 G2 扩展矩阵）：
 *   read: read_file, read_policy, read_section, file_info
 *   search: grep, glob, semantic_search, repo_map, repo_graph,
 *           related_tests, inspect_project, ls
 *   不可折叠: write_file, edit_file, hash_edit, apply_patch, bash,
 *            run_tests, delegate_*, team_*, todo, recall, web_*, plan_*, 等
 */
export function isCollapsibleTool(toolName: string): boolean {
  return classifyCollapsibleKind(toolName) !== null
}

/** 折叠工具的子分类；非折叠工具返回 null */
export function classifyCollapsibleKind(toolName: string): CollapsibleKind | null {
  const t = toolName.toLowerCase()

  // read 族：读取文件/策略/artifact/元信息
  if (
    t === 'read_file' || t === 'read' || t === 'read-file' ||
    t === 'read_policy' || t === 'read_section' || t === 'file_info'
  ) {
    return 'read'
  }

  // search 族：代码搜索/结构探索
  if (
    t === 'grep' || t === 'glob' || t === 'semantic_search' ||
    t === 'repo_map' || t === 'repo_graph' ||
    t === 'related_tests' || t === 'inspect_project' || t === 'ls'
  ) {
    return 'search'
  }

  return null
}

/** 非折叠工具到达时是否应打断当前组 */
export function shouldBreakGroup(toolName: string): boolean {
  return !isCollapsibleTool(toolName)
}

// ── Entry display ──────────────────────────────────────────────

/** 从 tool input 提取可读的展示名（文件名/查询模式/路径） */
export function entryDisplayName(toolName: string, input: Record<string, unknown>): string {
  const t = toolName.toLowerCase()

  // read 族：file_path > file > path
  if (t === 'read_file' || t === 'read' || t === 'read_policy' || t === 'read_section') {
    const path = input.file_path ?? input.file ?? input.path ?? '?'
    return typeof path === 'string' ? path : '?'
  }

  // grep：显示 "pattern" in path
  if (t === 'grep') {
    const pattern = input.pattern ?? input.query ?? '?'
    const scope = input.path ?? input.dir ?? ''
    const p = typeof pattern === 'string' ? pattern : '?'
    const s = typeof scope === 'string' && scope ? ` in ${scope}` : ''
    return `"${p}"${s}`
  }

  // glob / semantic_search：显示模式/查询
  if (t === 'glob') {
    const pattern = input.pattern ?? input.query ?? '?'
    return typeof pattern === 'string' ? pattern : '?'
  }
  if (t === 'semantic_search') {
    const query = input.query ?? '?'
    return typeof query === 'string' ? query : '?'
  }

  // file_info / ls：显示路径
  if (t === 'file_info' || t === 'ls') {
    const path = input.path ?? input.file_path ?? input.dir ?? '.'
    return typeof path === 'string' ? path : '.'
  }

  // repo_map / repo_graph / inspect_project / related_tests：显示路径/文件
  if (t === 'repo_map' || t === 'repo_graph' || t === 'inspect_project' || t === 'related_tests') {
    const path = input.path ?? input.from_file ?? input.file ?? '.'
    return typeof path === 'string' ? path : '.'
  }

  return toolName
}

// ── Entry lookup ───────────────────────────────────────────────

/** 在组中按 toolUseId 查找 entry（O(n)，n 通常 < 10） */
export function findEntryById(
  group: CollapsedReadSearchGroup,
  id: string,
): CollapsedReadSearchEntry | null {
  return group.entries.find(e => e.id === id) ?? null
}

/** 将 terminal result 绑定到对应 entry */
export function attachResult(
  group: CollapsedReadSearchGroup,
  id: string,
  content: string,
  isError?: boolean,
): CollapsedReadSearchEntry | null {
  const entry = findEntryById(group, id)
  if (!entry) return null
  entry.content = content
  entry.isError = isError ?? false
  entry.completed = true
  return entry
}

// ── Summary (computed, no stored counters) ─────────────────────

export interface GroupStats {
  searchCount: number
  readFilePaths: string[]
  listCount: number
  completedCount: number
  pendingCount: number
}

/**
 * 从 entries 实时计算统计（不存储可变计数器，避免 sync 问题）。
 * 仅统计 completed entry。
 */
export function computeGroupStats(group: CollapsedReadSearchGroup): GroupStats {
  let searchCount = 0
  const readFilePaths = new Set<string>()
  let listCount = 0
  let completedCount = 0
  let pendingCount = 0

  for (const entry of group.entries) {
    if (entry.completed) {
      completedCount++
      switch (entry.kind) {
        case 'search':
          searchCount++
          break
        case 'read':
          readFilePaths.add(entry.displayName)
          break
        case 'list':
          listCount++
          break
      }
    } else {
      pendingCount++
    }
  }

  return {
    searchCount,
    readFilePaths: [...readFilePaths],
    listCount,
    completedCount,
    pendingCount,
  }
}

/** 构建组摘要文本（用于 scrollback 标题和 live 聚合行） */
export function buildSummaryText(group: CollapsedReadSearchGroup, isActive?: boolean): string {
  const stats = computeGroupStats(group)
  const parts: string[] = []

  if (stats.searchCount > 0) {
    parts.push(`Searched ${stats.searchCount} pattern${stats.searchCount > 1 ? 's' : ''}`)
  }
  if (stats.readFilePaths.length > 0) {
    parts.push(`Read ${stats.readFilePaths.length} file${stats.readFilePaths.length > 1 ? 's' : ''}`)
  }
  if (stats.listCount > 0) {
    parts.push(`Listed ${stats.listCount} dir${stats.listCount > 1 ? 's' : ''}`)
  }

  if (isActive && stats.pendingCount > 0) {
    parts.push(`${stats.pendingCount} pending`)
  }

  return parts.length > 0 ? parts.join(', ') : '…'
}

// ── Rendering: scrollback ──────────────────────────────────────

export interface FormatCollapsedGroupInput {
  group: CollapsedReadSearchGroup
  expanded?: boolean
  theme: RivetTheme
  columns?: number
}

/** 渲染折叠的 read+search 组（用于 scrollback） */
export function formatCollapsedGroup(input: FormatCollapsedGroupInput): string[] {
  const { group, expanded, theme } = input
  const lines: string[] = []
  const summary = buildSummaryText(group, false)
  const elapsed = Date.now() - group.startMs
  const elapsedStr = elapsed > 1000 ? `${(elapsed / 1000).toFixed(1)}s` : `${elapsed}ms`

  // 摘要行
  lines.push(color(`● ${summary} · ${elapsedStr}`, theme.primary))

  const completed = group.entries.filter(e => e.completed)
  const hasPending = group.entries.some(e => !e.completed)

  if (completed.length === 0) {
    if (hasPending) {
      lines.push(color('  (results pending…)', theme.muted))
    }
    return lines
  }

  if (expanded) {
    // 展开模式：显示所有 entry 的完整内容
    for (const entry of completed) {
      const lineCount = entry.content ? entry.content.split('\n').length : 0
      const lc = lineCount > 0 ? ` (${lineCount}L)` : ''
      lines.push(`  ⎿  ${color(entry.displayName, theme.muted)}${lc}`)
      if (entry.content) {
        const previewLines = entry.content.split('\n').slice(0, 30)
        for (const pl of previewLines) {
          const trimmed = pl.length > 80 ? pl.slice(0, 79) + '…' : pl
          lines.push(`     ${color(trimmed, theme.muted)}`)
        }
        if (lineCount > 30) {
          lines.push(color(`     … +${lineCount - 30} more lines`, theme.muted))
        }
      }
    }
  } else if (completed.length <= 3) {
    // 小折叠：显示全部 entry + 内容预览（最多 3 行/entry）
    for (const entry of completed) {
      const lineCount = entry.content ? entry.content.split('\n').length : 0
      const lc = lineCount > 0 ? ` (${lineCount}L)` : ''
      lines.push(`  ⎿  ${color(entry.displayName, theme.muted)}${lc}`)
      if (entry.content) {
        const previewLines = entry.content.split('\n').slice(0, 3)
        for (const pl of previewLines) {
          const trimmed = pl.length > 80 ? pl.slice(0, 79) + '…' : pl
          lines.push(`     ${color(trimmed, theme.muted)}`)
        }
        if (lineCount > 3) {
          lines.push(color(`     … +${lineCount - 3} more lines`, theme.muted))
        }
      }
    }
  } else {
    // 大折叠（>3 条）：紧凑路径列表 + ctrl+o 提示
    const files = completed.map(e => e.displayName).join(', ')
    const preview = files.length > 80 ? files.slice(0, 79) + '…' : files
    lines.push(`  ⎿  ${color(preview, theme.muted)}`)
    lines.push(color(`     … +${completed.length - 3} more files [Ctrl+O]`, theme.secondary))
  }

  return lines
}

// ── Rendering: live region ─────────────────────────────────────

/**
 * 渲染 live 区域聚合行（进行中的探索工具）。
 * 区别于独立 tool card：所有 collapsible 工具聚合成一行，
 * 避免 live 区被 5+ 个 read/grep 卡片刷屏。
 */
export function formatCollapsedGroupLive(
  group: CollapsedReadSearchGroup,
  theme: RivetTheme,
  columns?: number,
): string[] {
  const lines: string[] = []
  const summary = buildSummaryText(group, true)
  const elapsed = Date.now() - group.startMs
  const elapsedStr = elapsed > 1000 ? `${(elapsed / 1000).toFixed(0)}s` : `${elapsed}ms`

  lines.push(`● ${color(summary, theme.muted)} ${color(`· ${elapsedStr}`, theme.muted)}`)

  // 显示最近一条已完成 entry 的末 2 行作为进度预览
  const lastCompleted = [...group.entries].reverse().find(e => e.content && e.completed)
  if (lastCompleted?.content) {
    const maxWidth = Math.max(10, (columns ?? 80) - 6)
    const tailLines = lastCompleted.content.replace(/\n+$/, '').split('\n').slice(-2)
    for (const line of tailLines) {
      const trimmed = line.length > maxWidth ? line.slice(0, maxWidth - 1) + '…' : line
      lines.push(`  ${color(trimmed, theme.muted)}`)
    }
  }

  return lines
}

// ── Buffer ─────────────────────────────────────────────────────

/**
 * CollapsedReadSearchBuffer — 管理折叠组的生命周期。
 *
 * 温跃层：buffer 管理从 app.ts 的事件处理器中分离出来，
 * 使 app.ts 只需调用 buffer API，无需管理内部状态。
 * buffer 可独立测试，不依赖 TuiApp 实例化。
 */
export class CollapsedReadSearchBuffer {
  private group: CollapsedReadSearchGroup | null = null

  /** 推入一个新的 collapsible tool use */
  pushUse(id: string, toolName: string, input: Record<string, unknown>): void {
    const kind = classifyCollapsibleKind(toolName)
    if (kind === null) return // 防御：不应被非 collapsible 调用

    if (!this.group) {
      this.group = { entries: [], startMs: Date.now() }
    }

    this.group.entries.push({
      id,
      toolName,
      input,
      displayName: entryDisplayName(toolName, input),
      kind,
      completed: false,
    })
  }

  /** 绑定 terminal result 到对应 entry（按 toolUseId） */
  attachResult(id: string, content: string, isError?: boolean): CollapsedReadSearchEntry | null {
    if (!this.group) return null
    return attachResult(this.group, id, content, isError)
  }

  /** 新到达的 tool 是否应打断当前组 */
  shouldBreak(toolName: string): boolean {
    return shouldBreakGroup(toolName)
  }

  /** 取出当前组并清空 buffer（flush 到 scrollback） */
  flush(): CollapsedReadSearchGroup | null {
    const g = this.group
    this.group = null
    return g
  }

  /** 获取当前活跃组（不清空，用于 live 渲染和状态检查） */
  getActive(): CollapsedReadSearchGroup | null {
    return this.group
  }

  /** 当前组中是否还有未完成的 entry */
  hasPending(): boolean {
    return this.group?.entries.some(e => !e.completed) ?? false
  }

  /** 是否有活跃组 */
  isActive(): boolean {
    return this.group !== null
  }
}
