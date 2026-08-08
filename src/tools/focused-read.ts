import { summarizeFileContent } from '../artifact/summarize.js'
import { foldCode } from '../compact/code-fold.js'

export interface FocusedReadRange {
  startLine: number
  endLine: number
  score: number
}

export interface FocusedReadResult {
  content: string
  ranges: FocusedReadRange[]
  matchedLines: number
  omittedLines: number
  matched: boolean
}

export interface FocusedReadOptions {
  filePath: string
  content: string
  focus: string
  maxChars: number
  maxMatches?: number
  contextLines?: number
}

const DEFAULT_MAX_MATCHES = 8
const DEFAULT_CONTEXT_LINES = 2
const MAX_FOCUS_LENGTH = 240

const FOCUS_STOP_WORDS = new Set([
  'a', 'an', 'and', 'for', 'from', 'find', 'file', 'into', 'look', 'read', 'the', 'this', 'with',
  'please', 'show', 'where', 'what', 'which', 'code', 'source', 'implementation',
  '请', '帮我', '查找', '读取', '看看', '文件', '代码', '实现', '相关', '问题', '一下', '里面',
])

const STRUCTURAL_LINE = /^\s*(?:import\b|export\b|(?:async\s+)?function\b|class\b|interface\b|type\b|enum\b|const\b|let\b|var\b|def\b|struct\b|impl\b|trait\b|#{1,6}\s)/

function normalizeFocus(focus: string): string {
  return focus.replace(/\s+/g, ' ').trim().slice(0, MAX_FOCUS_LENGTH)
}

function tokenizeFocus(focus: string): string[] {
  const fragments = normalizeFocus(focus).toLowerCase().match(/[a-z_$][a-z0-9_$-]{1,}|[\u4e00-\u9fff]+/g) ?? []
  const tokens = new Set<string>()

  for (const fragment of fragments) {
    if (/^[a-z_$]/.test(fragment)) {
      if (fragment.length >= 2 && !FOCUS_STOP_WORDS.has(fragment)) tokens.add(fragment)
      continue
    }

    if (fragment.length === 1) {
      if (!FOCUS_STOP_WORDS.has(fragment)) tokens.add(fragment)
      continue
    }
    for (let i = 0; i < fragment.length - 1; i++) {
      const bigram = fragment.slice(i, i + 2)
      if (!FOCUS_STOP_WORDS.has(bigram)) tokens.add(bigram)
    }
  }

  return [...tokens]
}

function scoreLine(line: string, focus: string, tokens: string[]): number {
  const lower = line.toLowerCase()
  const normalizedFocus = normalizeFocus(focus).toLowerCase()
  let score = 0

  if (normalizedFocus.length >= 4 && lower.includes(normalizedFocus)) score += 24

  let matches = 0
  for (const token of tokens) {
    if (!lower.includes(token)) continue
    matches++
    score += token.includes('_') || token.length >= 6 ? 7 : 3
  }

  if (matches > 1) score += matches * 2
  if (matches > 0 && STRUCTURAL_LINE.test(line)) score += 4
  return score
}

function mergeRanges(ranges: FocusedReadRange[]): FocusedReadRange[] {
  const sorted = [...ranges].sort((a, b) => a.startLine - b.startLine)
  const merged: FocusedReadRange[] = []

  for (const range of sorted) {
    const previous = merged[merged.length - 1]
    if (!previous || range.startLine > previous.endLine + 1) {
      merged.push({ ...range })
      continue
    }
    previous.endLine = Math.max(previous.endLine, range.endLine)
    previous.score = Math.max(previous.score, range.score)
  }

  return merged
}

function structuralSkeleton(filePath: string, lines: string[], content: string, maxChars: number): string {
  const folded = foldCode(content, { filePath, maxLines: 100 })
  const structural = folded.wasFolded
    ? folded.folded
    : lines.filter(line => STRUCTURAL_LINE.test(line)).slice(0, 100).join('\n')
  const body = structural.trim() || lines.slice(0, 40).join('\n')
  return body.slice(0, Math.max(600, maxChars))
}

function renderRanges(lines: string[], ranges: FocusedReadRange[]): string {
  return ranges.map(range => {
    const body = lines
      .slice(range.startLine, range.endLine + 1)
      .map((line, offset) => `${String(range.startLine + offset + 1).padStart(5, ' ')} | ${line}`)
      .join('\n')
    return `--- L${range.startLine + 1}-L${range.endLine + 1} (relevance ${range.score}) ---\n${body}`
  }).join('\n\n')
}

function renderFocusedContent(
  filePath: string,
  focus: string,
  lines: string[],
  summary: string,
  ranges: FocusedReadRange[],
  maxChars: number,
): string {
  const shownLines = ranges.reduce((sum, range) => sum + range.endLine - range.startLine + 1, 0)
  const header = [
    `[focused-read] ${filePath}`,
    `focus: ${normalizeFocus(focus)}`,
    `source: ${lines.length} lines, ${lines.join('\n').length} chars; showing ${shownLines} relevant lines`,
    summary ? `structural summary: ${summary}` : '',
    'Only the ranges below are selected evidence; this is not the complete file.',
  ].filter(Boolean).join('\n')

  const body = ranges.length > 0
    ? renderRanges(lines, ranges)
    : `No direct focus match. Structural outline only:\n${structuralSkeleton(filePath, lines, lines.join('\n'), Math.max(800, maxChars - header.length))}`
  const omitted = Math.max(0, lines.length - shownLines)
  const footer = `\n\n[focused-read] omitted ${omitted} source lines; use read_file(offset, limit) for an exact range.`
  const output = `${header}\n\n${body}${footer}`
  if (output.length <= maxChars) return output
  return `${output.slice(0, Math.max(0, maxChars - 80))}\n...[focused-read output capped at ${maxChars} chars]`
}

/**
 * Select high-signal source ranges for a task-oriented read.
 *
 * This is deliberately deterministic and read-only. It does not claim that
 * unselected code is irrelevant; it makes the omission explicit and points
 * the model to an exact-range read when more evidence is needed.
 */
export function buildFocusedReadView(options: FocusedReadOptions): FocusedReadResult {
  const focus = normalizeFocus(options.focus)
  const lines = options.content.split('\n')
  const tokens = tokenizeFocus(focus)
  const contextLines = Math.max(0, Math.min(8, Math.floor(options.contextLines ?? DEFAULT_CONTEXT_LINES)))
  const maxMatches = Math.max(1, Math.min(20, Math.floor(options.maxMatches ?? DEFAULT_MAX_MATCHES)))
  const maxChars = Math.max(800, Math.floor(options.maxChars))
  const summary = summarizeFileContent(options.content, options.filePath).summary.trim()

  const ranked = tokens.length === 0
    ? []
    : lines
      .map((line, index) => ({ line, index, score: scoreLine(line, focus, tokens) }))
      .filter(entry => entry.score > 0)
      .sort((a, b) => b.score - a.score || a.index - b.index)

  const selected = ranked.slice(0, maxMatches).map(entry => ({
    startLine: Math.max(0, entry.index - contextLines),
    endLine: Math.min(lines.length - 1, entry.index + contextLines),
    score: entry.score,
  }))
  let ranges = mergeRanges(selected)

  // Keep the highest-scoring ranges if a few broad windows exceed the budget.
  while (ranges.length > 1 && renderRanges(lines, ranges).length > Math.max(400, maxChars - 600)) {
    const lowest = ranges.reduce((index, range, current) => range.score < ranges[index]!.score ? current : index, 0)
    ranges = ranges.filter((_, index) => index !== lowest)
  }

  const content = renderFocusedContent(options.filePath, focus, lines, summary, ranges, maxChars)
  const matchedLines = ranges.reduce((sum, range) => sum + range.endLine - range.startLine + 1, 0)
  return {
    content,
    ranges,
    matchedLines,
    omittedLines: Math.max(0, lines.length - matchedLines),
    matched: ranges.length > 0,
  }
}
