/**
 * T9 格式化函数 — diff 输出。
 *
 * 纯函数，从 `diff-render.tsx` 的渲染逻辑提取。
 */

import { ANSI, color, fileLink } from '../engine/ansi.js'
import type { RivetTheme } from '../theme.js'
import { hiddenLinesMarker } from './hidden-lines.js'

export interface FormatDiffInput {
  /** diff 文本内容 */
  content: string
  /** 最大显示行数 */
  maxLines?: number
  /** 行内 word-level 高亮：配对相邻 del→add 行，差异 token 加粗（默认 true）。 */
  inlineDiff?: boolean
}

const DEFAULT_MAX_LINES = 50

/** 行内 diff 的行长上限（字符）：超长行跳过，避免 O(n²) 与视觉噪音。 */
const MAX_INLINE_DIFF_CHARS = 400
/** \w 实词公共比例下限：低于视为无关行对（删除一行 + 新增完全不同行）。 */
const MIN_WORD_COMMON_RATIO = 0.3

type WordSeg = [text: string, isDiff: 0 | 1]

/** 按空白 / 实词（\w 含数字下划线，`5_000` 保持整 token）/ 单字符标点三类切分。 */
function tokenizeWords(s: string): string[] {
  return s.split(/(\s+|\w+|[^\w\s])/g).filter((t) => t.length > 0)
}

/** 自底向上 LCS 表（token 级）。 */
function lcsTable(a: string[], b: string[]): number[][] {
  const m = a.length
  const n = b.length
  const dp: number[][] = Array.from({ length: m + 1 }, () => new Array(n + 1).fill(0))
  for (let i = m - 1; i >= 0; i--) {
    for (let j = n - 1; j >= 0; j--) {
      dp[i]![j] = a[i] === b[j] ? dp[i + 1]![j + 1]! + 1 : Math.max(dp[i + 1]![j]!, dp[i]![j + 1]!)
    }
  }
  return dp
}

/**
 * 行内 word-level diff：返回两侧的分段列表（isDiff=1 为差异段）与 \w 实词公共比例。
 * 比例只按 \w 实词计算——标点/空白太容易公共，会虚高（探针实证：`foo()` vs
 * `bar baz qux()` 全 token 比例 67%，\w-only 0%）。
 */
function diffWords(oldStr: string, newStr: string): { oldSegs: WordSeg[]; newSegs: WordSeg[]; wordCommonRatio: number } {
  const a = tokenizeWords(oldStr)
  const b = tokenizeWords(newStr)
  const dp = lcsTable(a, b)
  const oldSegs: WordSeg[] = []
  const newSegs: WordSeg[] = []
  let i = 0
  let j = 0
  while (i < a.length || j < b.length) {
    if (i < a.length && j < b.length && a[i] === b[j]) {
      oldSegs.push([a[i]!, 0]); newSegs.push([b[j]!, 0]); i++; j++
    } else if (j < b.length && (i >= a.length || dp[i + 1]![j]! <= dp[i]![j + 1]!)) {
      newSegs.push([b[j]!, 1]); j++
    } else {
      oldSegs.push([a[i]!, 1]); i++
    }
  }
  const wordTokens = (segs: WordSeg[]) => segs.filter(([t]) => /^\w/.test(t))
  const common = wordTokens(oldSegs).filter(([, d]) => d === 0).length
  const ratio = common / Math.max(wordTokens(oldSegs).length, wordTokens(newSegs).length, 1)
  return { oldSegs, newSegs, wordCommonRatio: ratio }
}

/** diff 统计信息（adds/dels 不含文件头，hunks 为 @@ 头数量） */
export interface DiffStats {
  adds: number
  dels: number
  hunks: number
}

/** 从 diff 文本提取统计：添加行数、删除行数、hunk 数。 */
export function computeDiffStats(content: string): DiffStats {
  const lines = content.split('\n')
  let adds = 0
  let dels = 0
  let hunks = 0
  for (const line of lines) {
    if (line.startsWith('@@')) { hunks++; continue }
    if (line.startsWith('+') && !line.startsWith('+++')) { adds++; continue }
    if (line.startsWith('-') && !line.startsWith('---')) { dels++; continue }
  }
  return { adds, dels, hunks }
}

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
    if (line.startsWith('diff --git')) { diffSignals += 2; continue }
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

  const stats = computeDiffStats(input.content)

  const lineNumbers = computeLineNumbers(allLines)
  const gutterWidth = lineNumbers
    ? Math.max(3, ...lineNumbers.filter((l): l is string => l !== null).map(l => l.length))
    : 0

  const truncated = allLines.length > maxLines
  const headCount = Math.floor(maxLines / 2)
  type Row = { line: string; label: string | null }
  const rows: Row[] = allLines.map((line, i) => ({ line, label: lineNumbers?.[i] ?? null }))
  const displayRows: Row[] = truncated
    ? [...rows.slice(0, headCount), { line: hiddenLinesMarker(allLines.length - maxLines), label: null }, ...rows.slice(-headCount)]
    : rows

  // 配对相邻 del→add 行做行内 word diff：修改行典型形态为 `-old` 紧跟 `+new`。
  // 截断插入的 hiddenLinesMarker 行类型为 context，天然阻断跨截断边界的配对。
  const pairedSegs = new Map<number, WordSeg[]>()
  const inlineEnabled = input.inlineDiff ?? true
  if (inlineEnabled) {
    for (let i = 1; i < displayRows.length; i++) {
      const prev = displayRows[i - 1]!
      const cur = displayRows[i]!
      if (classifyLine(cur.line) !== 'add' || classifyLine(prev.line) !== 'del') continue
      if (prev.line.length > MAX_INLINE_DIFF_CHARS || cur.line.length > MAX_INLINE_DIFF_CHARS) continue
      const { oldSegs, newSegs, wordCommonRatio } = diffWords(prev.line.slice(1), cur.line.slice(1))
      if (wordCommonRatio < MIN_WORD_COMMON_RATIO) continue
      pairedSegs.set(i - 1, oldSegs)
      pairedSegs.set(i, newSegs)
    }
  }

  const lines: string[] = []

  // Summary header
  lines.push(color(`diff: +${stats.adds} −${stats.dels}${truncated ? ` (${allLines.length} total, showing ${maxLines})` : ''}`, theme.secondary))

  // Content
  for (let i = 0; i < displayRows.length; i++) {
    const row = displayRows[i]!
    const type = classifyLine(row.line)
    const lineColor = getDiffColor(type, theme)
    let rendered: string
    const segs = pairedSegs.get(i)
    if (segs) {
      // 行内高亮：差异 token 加粗，公共 token 保持行级颜色。
      // slice(1) 切掉的 unified diff 行首标记（-/+）在此补回。
      const prefix = type === 'add' ? '+' : '-'
      rendered = color(prefix, lineColor) + segs.map(([text, isDiff]) => (isDiff ? color(text, lineColor, { bold: true }) : color(text, lineColor))).join('')
    } else {
      rendered = color(row.line, lineColor)
      // 文件头 (---/+++) → OSC 8 可点击链接（不支持的终端纯文本降级）
      if (type === 'header') {
        const filePath = extractHeaderPath(row.line)
        if (filePath) rendered = fileLink(rendered, filePath)
      }
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
