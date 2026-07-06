/**
 * T9 格式化函数 — diff 输出。
 *
 * 纯函数，从 `diff-render.tsx` 的渲染逻辑提取。
 */

import { ANSI, color, fileLink } from '../engine/ansi.js'
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
 * 从 hunk 头解析起始行号。`@@ -a,b +c,d @@` → { old: a, new: c }。
 */
function parseHunkStart(line: string): { old: number; new: number } | null {
  const m = line.match(/^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/)
  if (!m) return null
  return { old: Number(m[1]), new: Number(m[2]) }
}

/**
 * 为每一行计算行号 gutter 标签（不含着色）。
 * 有 hunk 头才有行号语义：add/context 显示新文件行号，del 显示旧文件行号，
 * meta/header/hunk 行留白。无 hunk 的裸 +/- 片段返回 null（不加 gutter）。
 */
function computeLineNumbers(allLines: string[]): (string | null)[] | null {
  let oldNo = 0
  let newNo = 0
  let inHunk = false
  let sawHunk = false
  const labels: (string | null)[] = []
  for (const line of allLines) {
    const type = classifyLine(line)
    if (type === 'hunk') {
      const start = parseHunkStart(line)
      if (start) { oldNo = start.old; newNo = start.new; inHunk = true; sawHunk = true }
      labels.push(null)
      continue
    }
    if (!inHunk || type === 'meta' || type === 'header') { labels.push(null); continue }
    if (type === 'add') { labels.push(String(newNo)); newNo++; continue }
    if (type === 'del') { labels.push(String(oldNo)); oldNo++; continue }
    labels.push(String(newNo)); oldNo++; newNo++
  }
  return sawHunk ? labels : null
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
 *
 * 行号列（Wave 2）：含 hunk 头的完整 unified diff 渲染 dim 行号 gutter
 * （add/context = 新文件行号，del = 旧文件行号）；裸 +/- 片段保持原样。
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

  const lineNumbers = computeLineNumbers(allLines)
  const gutterWidth = lineNumbers
    ? Math.max(3, ...lineNumbers.filter((l): l is string => l !== null).map(l => l.length))
    : 0

  const truncated = allLines.length > maxLines
  const headCount = Math.floor(maxLines / 2)
  type Row = { line: string; label: string | null }
  const rows: Row[] = allLines.map((line, i) => ({ line, label: lineNumbers?.[i] ?? null }))
  const displayRows: Row[] = truncated
    ? [...rows.slice(0, headCount), { line: `... ${allLines.length - maxLines} lines hidden ...`, label: null }, ...rows.slice(-headCount)]
    : rows

  const lines: string[] = []

  // Summary header
  lines.push(color(`diff: +${adds} −${dels}${truncated ? ` (${allLines.length} total, showing ${maxLines})` : ''}`, theme.secondary))

  // Content
  for (const row of displayRows) {
    const type = classifyLine(row.line)
    const lineColor = getDiffColor(type, theme)
    // 文件头 (---/+++) → OSC 8 可点击链接（不支持的终端纯文本降级）
    let rendered = color(row.line, lineColor)
    if (type === 'header') {
      const filePath = extractHeaderPath(row.line)
      if (filePath) rendered = fileLink(rendered, filePath)
    }
    if (lineNumbers) {
      const gutter = color(`${(row.label ?? '').padStart(gutterWidth)}│`, theme.dim)
      lines.push(`${gutter}${rendered}`)
    } else {
      lines.push(rendered)
    }
  }

  return lines
}

/** 从 ---/+++ 文件头提取路径（剥 a// b/ 前缀；/dev/null 与时间戳后缀跳过）。 */
function extractHeaderPath(line: string): string | null {
  const m = /^(?:---|\+\+\+)\s+(.+)$/.exec(line)
  if (!m) return null
  // git diff 头可能带 \t 时间戳后缀
  let p = m[1]!.split('\t')[0]!.trim()
  if (p === '/dev/null') return null
  if (p.startsWith('a/') || p.startsWith('b/')) p = p.slice(2)
  return p || null
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
