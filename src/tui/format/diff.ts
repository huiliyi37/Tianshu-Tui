/**
 * T9 格式化函数 — diff 输出。
 *
 * 纯函数，从 `diff-render.tsx` 的渲染逻辑提取。
 */

import { ANSI, color } from '../engine/ansi.js'
import type { RivetTheme } from '../theme.js'

export interface FormatDiffInput {
  /** diff 文本内容 */
  content: string
  /** 最大显示行数 */
  maxLines?: number
}

const DEFAULT_MAX_LINES = 50

type DiffLineType = 'add' | 'del' | 'hunk' | 'context' | 'meta' | 'header'

/**
 * 启发式检测文本是否为 unified diff 内容。
 * （纯函数版，与 diff-render.tsx 中的实现一致——format 层零 React 依赖。）
 */
export function isDiffContent(text: string): boolean {
  let diffSignals = 0
  let hasHunk = false
  const lines = text.split('\n')
  for (const line of lines.slice(0, 20)) {
    if (!line) continue
    if (/^diff --git/.test(line)) { diffSignals += 2; continue }
    if (/^(---|\+\+\+)\s/.test(line)) { diffSignals++; continue }
    if (/^@@[^@]+@@/.test(line)) { hasHunk = true; diffSignals++; continue }
  }
  if (hasHunk && /^[-+]/m.test(text)) return true
  return diffSignals >= 2
}

/**
 * 格式化 diff 为 ANSI 行数组。
 *
 * 颜色映射：
 * - 添加行 (+): theme.success (绿)
 * - 删除行 (-): theme.error (红)
 * - hunk header (@@): theme.secondary
 * - 文件头 (---/+++): theme.warning
 * - 上下文行: theme.muted（上下文是真实代码=数据，dim 在墨夜底几乎不可见）
 * - meta (diff --git 等): theme.dim
 */
export function formatDiff(input: FormatDiffInput, theme: RivetTheme): string[] {
  const maxLines = input.maxLines ?? DEFAULT_MAX_LINES
  const allLines = input.content.split('\n')

  // 统计
  let adds = 0
  let dels = 0
  for (const line of allLines) {
    if (line.startsWith('+') && !line.startsWith('+++')) adds++
    else if (line.startsWith('-') && !line.startsWith('---')) dels++
  }

  const truncated = allLines.length > maxLines
  const displayLines = truncated
    ? [...allLines.slice(0, Math.floor(maxLines / 2)), `... ${allLines.length - maxLines} lines hidden ...`, ...allLines.slice(-Math.floor(maxLines / 2))]
    : allLines

  const lines: string[] = []

  // Summary header
  lines.push(color(`diff: +${adds} −${dels}${truncated ? ` (${allLines.length} total, showing ${maxLines})` : ''}`, theme.secondary))

  // Content
  for (const line of displayLines) {
    const type = classifyLine(line)
    const lineColor = getDiffColor(type, theme)
    lines.push(color(line, lineColor))
  }

  return lines
}

function classifyLine(line: string): DiffLineType {
  if (line.startsWith('diff ') || line.startsWith('index ') || line.startsWith('new ') || line.startsWith('old ') || line.startsWith('rename ') || line.startsWith('similarity ')) return 'meta'
  if (line.startsWith('---') || line.startsWith('+++')) return 'header'
  if (line.startsWith('@@')) return 'hunk'
  if (line.startsWith('+')) return 'add'
  if (line.startsWith('-')) return 'del'
  return 'context'
}

function getDiffColor(type: DiffLineType, theme: RivetTheme): string {
  switch (type) {
    case 'add': return theme.success
    case 'del': return theme.error
    case 'hunk': return theme.secondary
    case 'header': return theme.warning
    case 'meta': return theme.dim
    case 'context': return theme.muted
  }
}
