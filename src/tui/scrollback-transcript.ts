/**
 * Scrollback transcript parser — turns CommitEngine text into message-level units
 * for the `/scroll` (pager) overlay search and expansion.
 *
 * 解析策略（保守启发式）：
 * - 按行扫描，识别消息起始标记。
 * - 用户消息：行首（去 ANSI 后）为 `▌` 或 `❯`。
 * - 工具结果：行首（去 ANSI 后）为 `●`。
 * - 其余连续行归为一个 assistant/system 块。
 * - 截断检测：消息内含 `… +N lines [Ctrl+O]` 或 `… [Ctrl+O]` 时标记为 truncated。
 */

import { displayWidth } from './width.js'

const ANSI_RE = /\x1B\[[0-9;]*[a-zA-Z]/g

function stripAnsi(s: string): string {
  return s.replace(ANSI_RE, '')
}

export type TranscriptRole = 'user' | 'assistant' | 'tool' | 'system'

export interface TranscriptMessage {
  /** 消息在 scrollback 中的起始行索引 */
  startLine: number
  /** 消息在 scrollback 中的结束行索引（不含） */
  endLine: number
  role: TranscriptRole
  /** 首行去 ANSI 后的摘要 */
  summary: string
  /** 完整 ANSI 行 */
  lines: string[]
  /** 是否包含被截断的工具输出 */
  isTruncated: boolean
  /** 去 ANSI 后的原始内容，用于搜索 */
  rawContent: string
}

function detectRole(strippedFirstLine: string): TranscriptRole | null {
  const trimmed = strippedFirstLine.trimStart()
  // U+258C left half block (user marker) / U+276F heavy right-pointing angle bracket
  if (trimmed.startsWith('\u258C') || trimmed.startsWith('\u276F')) return 'user'
  // U+25CF black circle (tool marker)
  if (trimmed.startsWith('\u25CF')) return 'tool'
  // box-drawing corners for system blocks
  if (trimmed.startsWith('┌─') || trimmed.startsWith('╭─')) return 'system'
  return null
}

function isTruncatedMessage(lines: string[]): boolean {
  for (const line of lines) {
    const stripped = stripAnsi(line)
    if (/…\s*\+\d+\s+lines\s*\[Ctrl\+O\]/i.test(stripped)) return true
    if (/…\s*\[Ctrl\+O\]/i.test(stripped)) return true
  }
  return false
}

function makeSummary(role: TranscriptRole, firstLine: string): string {
  const stripped = stripAnsi(firstLine).trimStart()
  const maxLen = 80
  if (stripped.length > maxLen) return stripped.slice(0, maxLen - 1) + '…'
  return stripped
}

/**
 * 解析 scrollback 内容为消息列表。
 */
export function parseScrollbackTranscript(content: string): TranscriptMessage[] {
  if (!content.trim()) return []
  const allLines = content.split('\n')
  const messages: TranscriptMessage[] = []
  let currentStart = 0
  let currentRole: TranscriptRole = 'assistant'
  let currentLines: string[] = []

  function flush(end: number): void {
    if (currentLines.length === 0) return
    messages.push({
      startLine: currentStart,
      endLine: end,
      role: currentRole,
      summary: makeSummary(currentRole, currentLines[0]!),
      lines: currentLines,
      isTruncated: isTruncatedMessage(currentLines),
      rawContent: currentLines.map(stripAnsi).join('\n').toLowerCase(),
    })
  }

  for (let i = 0; i < allLines.length; i++) {
    const line = allLines[i]!
    const role = detectRole(stripAnsi(line))
    if (role !== null) {
      flush(i)
      currentStart = i
      currentRole = role
      currentLines = [line]
    } else {
      currentLines.push(line)
    }
  }
  flush(allLines.length)
  return messages
}

/**
 * 在消息列表中搜索 query（大小写不敏感）。
 * 返回匹配的消息索引数组。
 */
export function searchTranscript(messages: readonly TranscriptMessage[], query: string): number[] {
  const q = query.trim().toLowerCase()
  if (!q) return []
  const matches: number[] = []
  for (let i = 0; i < messages.length; i++) {
    if (messages[i]!.rawContent.includes(q)) matches.push(i)
  }
  return matches
}

/**
 * 找到下一个匹配索引，循环。
 */
export function findNextMatch(messages: readonly TranscriptMessage[], current: number, query: string): number {
  const matches = searchTranscript(messages, query)
  if (matches.length === 0) return current
  const next = matches.find(idx => idx > current)
  return next ?? matches[0]!
}

/**
 * 找到上一个匹配索引，循环。
 */
export function findPrevMatch(messages: readonly TranscriptMessage[], current: number, query: string): number {
  const matches = searchTranscript(messages, query)
  if (matches.length === 0) return current
  const prev = [...matches].reverse().find(idx => idx < current)
  return prev ?? matches[matches.length - 1]!
}

/**
 * 估算某条消息在 overlay 中占多少显示行（粗略）。
 */
export function estimateMessageRows(message: TranscriptMessage, columns: number): number {
  let rows = 0
  for (const line of message.lines) {
    const w = displayWidth(line)
    rows += Math.max(1, Math.ceil(w / Math.max(1, columns)))
  }
  return rows
}

/**
 * 计算从第一条消息到指定消息起始处的累计显示行数。
 */
export function cumulativeRowsToMessage(
  messages: readonly TranscriptMessage[],
  targetIndex: number,
  columns: number,
): number {
  let rows = 0
  for (let i = 0; i < targetIndex && i < messages.length; i++) {
    rows += estimateMessageRows(messages[i]!, columns)
  }
  return rows
}
