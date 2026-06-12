/**
 * T9 权限 diff 预览 — 审批 write/edit 前渲染变更预览。
 */

import { color } from '../engine/ansi.js'
import type { RivetTheme } from '../theme.js'

export interface PermissionDiffInput {
  toolName: string
  input: Record<string, unknown>
  theme: RivetTheme
  columns?: number
}

export function formatPermissionDiff(input: PermissionDiffInput): string[] | null {
  const { toolName, input: params, theme } = input
  const name = toolName.toLowerCase()

  if (name === 'hash_edit' || name === 'edit_file' || name === 'edit') {
    return formatEditDiff(params, theme)
  }
  if (name === 'write_file' || name === 'write' || name === 'write-file') {
    return formatWritePreview(params, theme)
  }
  return null
}

function formatEditDiff(params: Record<string, unknown>, theme: RivetTheme): string[] | null {
  const oldStr = typeof params.old_string === 'string' ? params.old_string : null
  const newStr = typeof params.new_string === 'string' ? params.new_string : null
  if (!oldStr || !newStr) return null

  const oldLines = oldStr.split('\n')
  const newLines = newStr.split('\n')
  const maxLines = 12

  const lines: string[] = []
  lines.push('')
  lines.push(color('┌─ File Edit Preview ──────────────────────────────', theme.warning))

  // Simple inline diff: show old as red, new as green
  if (oldLines.length <= 3 && newLines.length <= 3) {
    for (const ol of oldLines.slice(0, maxLines)) {
      lines.push(color(`│ - ${ol.slice(0, 60)}${ol.length > 60 ? '…' : ''}`, theme.error))
    }
    for (const nl of newLines.slice(0, maxLines)) {
      lines.push(color(`│ + ${nl.slice(0, 60)}${nl.length > 60 ? '…' : ''}`, theme.success))
    }
  } else {
    // 只显示首尾几行
    const show = Math.min(3, Math.floor(maxLines / 2))
    for (const ol of oldLines.slice(0, show)) {
      lines.push(color(`│ - ${ol.slice(0, 60)}${ol.length > 60 ? '…' : ''}`, theme.error))
    }
    if (oldLines.length > show * 2) {
      lines.push(color(`│ … ${oldLines.length - show * 2} more removed lines`, theme.muted))
    }
    for (const ol of oldLines.slice(-show)) {
      lines.push(color(`│ - ${ol.slice(0, 60)}${ol.length > 60 ? '…' : ''}`, theme.error))
    }
    lines.push(color('│ ──────────────────────────────', theme.muted))
    for (const nl of newLines.slice(0, show)) {
      lines.push(color(`│ + ${nl.slice(0, 60)}${nl.length > 60 ? '…' : ''}`, theme.success))
    }
    if (newLines.length > show * 2) {
      lines.push(color(`│ … +${newLines.length - show * 2} more added lines`, theme.muted))
    }
    for (const nl of newLines.slice(-show)) {
      lines.push(color(`│ + ${nl.slice(0, 60)}${nl.length > 60 ? '…' : ''}`, theme.success))
    }
  }

  lines.push(color('└──────────────────────────────────────────────────', theme.warning))
  return lines
}

function formatWritePreview(params: Record<string, unknown>, theme: RivetTheme): string[] | null {
  const filePath = typeof params.file_path === 'string' ? params.file_path : null
  const content = typeof params.content === 'string' ? params.content : null
  if (!filePath) return null

  const lines: string[] = []
  lines.push('')
  lines.push(color('┌─ Write File Preview ─────────────────────────────', theme.warning))
  lines.push(`│ ${color('Path:', theme.muted)} ${filePath}`)

  if (content) {
    const contentLines = content.split('\n')
    lines.push(`│ ${color(`${contentLines.length} lines`, theme.muted)}`)
    for (const cl of contentLines.slice(0, 4)) {
      lines.push(`│ ${color(cl.slice(0, 58), theme.dim)}`)
    }
    if (contentLines.length > 4) {
      lines.push(color(`│ … +${contentLines.length - 4} more lines`, theme.muted))
    }
  }

  lines.push(color('└──────────────────────────────────────────────────', theme.warning))
  return lines
}
