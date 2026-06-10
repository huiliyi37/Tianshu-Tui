/**
 * T9 格式化函数 — 工具卡片。
 *
 * 纯函数，从 `tool-card.tsx` 的渲染逻辑提取。
 * 输入数据 + 主题色 → ANSI 格式化字符串数组。
 */

import { ANSI, color } from '../engine/ansi.js'
import type { RivetTheme } from '../theme.js'

export interface FormatToolCardInput {
  /** 工具名称 */
  toolName: string
  /** 工具输出内容 */
  content: string
  /** 是否为错误输出 */
  isError?: boolean
  /** 缩进深度（用于工具调用链的树形连接线） */
  depth?: number
  /** 原始文件路径（用于显示文件名） */
  rawPath?: string
  /** 输出行数限制 */
  maxLines?: number
  /** 工具耗时（毫秒），可选 */
  elapsedMs?: number
  /** 是否正在流式输出中 */
  streaming?: boolean
}

const DEFAULT_MAX_LINES = 25

/**
 * 格式化工具卡片为 ANSI 行数组。
 *
 * 渲染结构：
 * ├─ glyph verb … (lines) [expand]  (粗体 header，toolColor)
 * │  内容行                           (dim 边框 + 内容)
 * │  …                               (如果有更多行，省略)
 * raw: filename                      (如果未截断 + 有 rawPath，muted)
 */
export function formatToolCard(input: FormatToolCardInput, theme: RivetTheme): string[] {
  const {
    toolName,
    content,
    isError = false,
    depth = 0,
    rawPath,
    maxLines = DEFAULT_MAX_LINES,
    elapsedMs,
    streaming = false,
  } = input

  const lines: string[] = []
  const borderColor = isError ? theme.error : theme.toolColor(toolName)
  const contentLines = content.split('\n')
  const totalLines = contentLines.length
  const truncated = totalLines > maxLines
  const displayLines = truncated ? contentLines.slice(-maxLines) : contentLines

  // ── Header ──────────────────────────────────────────────────
  const glyph = getToolGlyph(toolName)
  const verb = getToolVerb(toolName)
  const parts: string[] = []

  // 树形连接线
  if (depth > 0) {
    parts.push(color('├─', theme.dim))
  }
  parts.push(glyph)
  parts.push(verb)

  if (streaming) {
    parts.push('…')
  } else if (elapsedMs !== undefined) {
    parts.push(formatElapsed(elapsedMs))
  }

  parts.push(`(${totalLines} lines)`)
  if (truncated) {
    parts.push(`[last ${maxLines}]`)
  }

  lines.push(color(parts.join(' '), borderColor, { bold: true }))

  // ── Body ────────────────────────────────────────────────────

  for (const line of displayLines) {
    lines.push(`${color('│', theme.dim)} ${color(line, borderColor)}`)
  }

  if (truncated) {
    const omitted = totalLines - maxLines
    lines.push(`${color('│', theme.dim)} ${color(`… ${omitted} lines omitted`, theme.dim)}`)
  }

  // ── Footer ──────────────────────────────────────────────────
  if (!truncated && rawPath) {
    const basename = rawPath.split('/').pop() ?? rawPath
    lines.push(color(`raw: ${basename}`, theme.muted))
  }

  return lines
}

// ── Helpers ───────────────────────────────────────────────────

const TOOL_GLYPHS: Record<string, string> = {
  bash: '⚡',
  grep: '🔍',
  glob: '📂',
  read_file: '📖',
  write_file: '✏️',
  edit_file: '✂️',
  run_tests: '✅',
  delegate_task: '📡',
  delegate_batch: '📡',
}

function getToolGlyph(name: string): string {
  return TOOL_GLYPHS[name] ?? '🔧'
}

const TOOL_VERBS: Record<string, string> = {
  bash: 'exec',
  grep: 'grep',
  glob: 'find',
  read_file: 'read',
  write_file: 'write',
  edit_file: 'edit',
  run_tests: 'test',
  delegate_task: 'delegate',
  delegate_batch: 'batch',
}

function getToolVerb(name: string): string {
  return TOOL_VERBS[name] ?? name
}

function formatElapsed(ms: number): string {
  if (ms < 1000) return `${ms}ms`
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`
  const mins = Math.floor(ms / 60_000)
  const secs = Math.round((ms % 60_000) / 1000)
  return `${mins}m${secs}s`
}
