/**
 * @deprecated 已迁移至 collapsed-read-search.ts。保留此文件仅用于向后兼容，
 * 将在 2026-06-28 后删除。新代码请使用：
 *   import { CollapsedReadSearchBuffer, isCollapsibleTool, formatCollapsedGroup } from './collapsed-read-search.js'
 *
 * T9 工具折叠组 — 将连续同族工具调用合并为一行摘要。
 */

import { color } from '../engine/ansi.js'
import type { RivetTheme } from '../theme.js'

export type GroupFamily = 'read' | 'search' | 'write' | 'patch' | 'exec' | 'other'

export interface ToolGroupEntry {
  toolName: string
  input: Record<string, unknown>
  displayName: string
  content?: string
  lineCount?: number
}

export interface ToolGroup {
  family: GroupFamily
  entries: ToolGroupEntry[]
  startMs: number
}

/**
 * @deprecated 使用 isCollapsibleTool() 替代
 */
export function groupFamily(toolName: string): GroupFamily {
  const t = toolName.toLowerCase()
  if (t === 'read_file' || t === 'read' || t === 'read-file') return 'read'
  if (t === 'grep' || t === 'glob' || t === 'ls' || t === 'semantic_search') return 'search'
  if (t === 'write_file' || t === 'write' || t === 'write-file') return 'write'
  if (t === 'edit_file' || t === 'hash_edit' || t === 'edit' || t === 'hash-edit' || t === 'apply_patch') return 'patch'
  if (t === 'bash' || t === 'run_tests' || t === 'exec') return 'exec'
  return 'other'
}

/**
 * @deprecated 使用 isCollapsibleTool() 替代
 */
export function canCollapse(family: GroupFamily): boolean {
  return family === 'read' || family === 'search'
}

/** 族的摘要标签 */
function familyLabel(family: GroupFamily): string {
  switch (family) {
    case 'read': return 'Reading'
    case 'search': return 'Searching'
    case 'write': return 'Writing'
    case 'patch': return 'Patching'
    case 'exec': return 'Running'
    default: return 'Tools'
  }
}

/** 族的图标 */
function familyGlyph(family: GroupFamily): string {
  switch (family) {
    case 'read': return '📖'
    case 'search': return '🔍'
    case 'write': return '✏'
    case 'patch': return '📝'
    case 'exec': return '▶'
    default: return '●'
  }
}

export interface FormatToolGroupInput {
  group: ToolGroup
  expanded?: boolean
  theme: RivetTheme
  columns?: number
}

/**
 * @deprecated 使用 formatCollapsedGroup() 替代
 */
export function formatToolGroup(input: FormatToolGroupInput): string[] {
  const { group, expanded, theme } = input
  const lines: string[] = []
  const label = familyLabel(group.family)
  const glyph = familyGlyph(group.family)
  const count = group.entries.length
  const elapsed = Date.now() - group.startMs

  // 折叠摘要行
  const elapsedStr = elapsed > 1000 ? `${(elapsed / 1000).toFixed(1)}s` : `${elapsed}ms`
  const title = `${glyph}  ${label} (${count} file${count > 1 ? 's' : ''}) · ${elapsedStr}`
  lines.push(color(`● ${title}`, theme.primary))

  if (expanded || count <= 3) {
    // 展开或少量文件：逐条列出 + 内容预览
    const maxLines = expanded ? 20 : 3
    for (const entry of group.entries.slice(0, maxLines)) {
      const lc = entry.content
        ? ` (${entry.content.split('\n').length}L)`
        : entry.lineCount ? ` (${entry.lineCount}L)` : ''
      lines.push(`  ⎿  ${color(entry.displayName, theme.muted)}${lc}`)
      // 内容预览：最多 3 行
      if (entry.content) {
        const previewLines = entry.content.split('\n').slice(0, 3)
        for (const pl of previewLines) {
          const trimmed = pl.length > 80 ? pl.slice(0, 79) + '…' : pl
          lines.push(`     ${color(trimmed, theme.dim)}`)
        }
        const totalLines = entry.content.split('\n').length
        if (totalLines > 3) {
          lines.push(color(`     … +${totalLines - 3} more lines`, theme.dim))
        }
      }
    }
    if (!expanded && count > 3) {
      lines.push(color(`     … +${count - 3} more files (ctrl+o to expand)`, theme.dim))
    }
  } else {
    // 折叠：只显示文件路径
    const files = group.entries.map(e => e.displayName).join(', ')
    const preview = files.length > 80 ? files.slice(0, 79) + '…' : files
    lines.push(`  ⎿  ${color(preview, theme.muted)}`)
  }

  return lines
}

/**
 * @deprecated 使用 entryDisplayName() from collapsed-read-search.ts 替代
 */
export function toolEntryDisplay(toolName: string, input: Record<string, unknown>): string {
  const t = toolName.toLowerCase()
  if (t === 'read_file' || t === 'read') {
    const path = input.file_path ?? input.file ?? input.path ?? '?'
    return typeof path === 'string' ? path : '?'
  }
  if (t === 'grep') {
    const pattern = input.pattern ?? input.query ?? '?'
    const p = typeof pattern === 'string' ? pattern : '?'
    return `"${p}"`
  }
  if (t === 'glob') {
    const inputPattern = input.pattern ?? input.query ?? '?'
    return typeof inputPattern === 'string' ? inputPattern : '?'
  }
  if (t === 'ls') {
    const path = input.path ?? input.dir ?? '.'
    return typeof path === 'string' ? path : '.'
  }
  if (t === 'semantic_search') {
    const query = input.query ?? '?'
    return typeof query === 'string' ? query : '?'
  }
  // fallback
  return toolName
}

/**
 * @deprecated 使用 shouldBreakGroup() from collapsed-read-search.ts 替代
 */
export function shouldFlushGroup(current: ToolGroup | null, newToolName: string): boolean {
  if (!current) return false
  const newFamily = groupFamily(newToolName)
  if (newFamily !== current.family) return true
  if (!canCollapse(newFamily)) return true
  return false
}
