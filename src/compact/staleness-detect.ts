/**
 * Layer 2: AgentDiet-style staleness detection.
 *
 * Identifies tool results that are:
 * - Superseded: a later tool read the same file → old version is stale
 * - Unreferenced: tool result was never mentioned in subsequent assistant text
 *
 * Uses a lag window (only evaluates results ≥ LAG steps old) to avoid
 * pruning content the model is still actively using.
 */
import type { OaiMessage, OaiAssistantMessage, OaiToolCall } from '../api/oai-types.js'
import { CACHE_ANCHOR_MESSAGES } from './constants.js'

const LAG_STEPS = 3 // only evaluate tool results at least 3 assistant turns old
const MIN_CONTENT_CHARS = 500 // skip short results

export interface StalenessResult {
  messages: OaiMessage[]
  supersededCount: number
  unreferencedCount: number
  freedChars: number
}

/** Parse an optional integer from tool call args (handles both number and string). */
function parseOptionalInt(val: unknown): number | undefined {
  if (val === undefined || val === null) return undefined
  const n = Number(val)
  if (Number.isNaN(n) || n <= 0) return undefined
  return Math.floor(n)
}

/** Check whether outer read range fully contains inner read range. */
function rangeContains(
  outer: { offset?: number; limit?: number },
  inner: { offset?: number; limit?: number },
): boolean {
  const outerStart = outer.offset ?? 1
  const outerEnd = outer.limit !== undefined ? outerStart + outer.limit - 1 : Infinity
  const innerStart = inner.offset ?? 1
  const innerEnd = inner.limit !== undefined ? innerStart + inner.limit - 1 : Infinity
  return outerStart <= innerStart && outerEnd >= innerEnd
}

/** Extract file path and optional range from tool call arguments. */
function extractFileInfo(args: string): { path: string; offset?: number; limit?: number } | undefined {
  try {
    const parsed = JSON.parse(args)
    const path = parsed.file_path || parsed.path || parsed.file
    if (!path) return undefined
    if (parsed.file_path !== undefined && (parsed.offset !== undefined || parsed.limit !== undefined)) {
      // Only read_file has offset/limit
      return { path, offset: parseOptionalInt(parsed.offset), limit: parseOptionalInt(parsed.limit) }
    }
    return { path }
  } catch { return undefined }
}

/** Check if assistant text references content from a tool result (simple heuristic). */
function isReferenced(toolContent: string, assistantTexts: string[]): boolean {
  // Extract a few distinctive tokens from the tool result
  const lines = toolContent.split('\n').filter(l => l.trim().length > 20)
  if (lines.length === 0) return true // can't determine, assume referenced

  // Check if any of the first 3 non-trivial lines appear in subsequent assistant text
  const samples = lines.slice(0, 3)
  const joined = assistantTexts.join(' ')
  for (const sample of samples) {
    const snippet = sample.trim().slice(0, 50)
    if (joined.includes(snippet)) return true
  }
  return false
}

export function detectStaleness(
  messages: OaiMessage[],
  anchorCount: number = CACHE_ANCHOR_MESSAGES,
): StalenessResult {
  // Build a map of file paths → later read entries with range info (for superseded detection)
  // Keyed by file_path; stores all later reads of that file with their index and range.
  const fileReads = new Map<string, Array<{ index: number; offset?: number; limit?: number }>>()
  // Build tool_call_id → tool name + args + cached fileInfo mapping
  const toolCallInfo = new Map<string, { name: string; args: string; fileInfo?: { path: string; offset?: number; limit?: number } }>()

  for (let i = messages.length - 1; i >= anchorCount; i--) {
    const msg = messages[i]!
    if (msg.role === 'assistant' && (msg as OaiAssistantMessage).tool_calls) {
      for (const tc of (msg as OaiAssistantMessage).tool_calls!) {
        const info: { name: string; args: string; fileInfo?: { path: string; offset?: number; limit?: number } } = {
          name: tc.function.name,
          args: tc.function.arguments,
        }
        if (tc.function.name === 'read_file' || tc.function.name === 'grep') {
          info.fileInfo = extractFileInfo(tc.function.arguments)
          if (info.fileInfo) {
            const reads = fileReads.get(info.fileInfo.path) ?? []
            reads.push({ index: i + 1, offset: info.fileInfo.offset, limit: info.fileInfo.limit })
            fileReads.set(info.fileInfo.path, reads)
          }
        }
        toolCallInfo.set(tc.id, info)
      }
    }
  }

  // Count assistant turns from end to determine lag
  const assistantIndices: number[] = []
  for (let i = messages.length - 1; i >= anchorCount; i--) {
    if (messages[i]!.role === 'assistant') assistantIndices.push(i)
  }

  // Collect assistant text after each tool result (for reference checking)
  let supersededCount = 0
  let unreferencedCount = 0
  let freedChars = 0

  const result = messages.map((msg, idx) => {
    if (idx < anchorCount) return msg
    if (msg.role !== 'tool') return msg
    if (msg.content.length < MIN_CONTENT_CHARS) return msg
    if (msg.content.startsWith('[')) return msg // already processed

    // Check lag: is this tool result old enough?
    const assistantTurnsAfter = assistantIndices.filter(ai => ai > idx).length
    if (assistantTurnsAfter < LAG_STEPS) return msg

    const info = toolCallInfo.get(msg.tool_call_id)
    if (!info) return msg

    // Check superseded: was the same file read again later with a range
    // that fully contains this read's range?
    if (info.name === 'read_file' || info.name === 'grep') {
      const fileInfo = info.fileInfo
      if (fileInfo) {
        const reads = fileReads.get(fileInfo.path) ?? []
        const laterReads = reads.filter(r => r.index > idx)
        const isSuperseded = info.name === 'read_file'
          ? laterReads.some(r => rangeContains(r, fileInfo))
          : laterReads.length > 0 // grep: any later grep of same path supersedes
        if (isSuperseded) {
          supersededCount++
          freedChars += msg.content.length
          return {
            ...msg,
            content: `[superseded: ${info.name} ${fileInfo.path.split('/').pop()} — re-read at later step]`,
          }
        }
      }
    }

    // Check unreferenced: was this result ever mentioned in subsequent assistant text?
    const subsequentAssistantText: string[] = []
    for (let j = idx + 1; j < messages.length; j++) {
      if (messages[j]!.role === 'assistant') {
        const aMsg = messages[j] as OaiAssistantMessage
        if (aMsg.content) subsequentAssistantText.push(aMsg.content)
      }
    }
    if (subsequentAssistantText.length >= LAG_STEPS && !isReferenced(msg.content, subsequentAssistantText)) {
      unreferencedCount++
      freedChars += msg.content.length
      return {
        ...msg,
        content: `[unreferenced: ${info.name} result (${msg.content.length} chars) — not cited in subsequent reasoning]`,
      }
    }

    return msg
  })

  return {
    messages: (supersededCount + unreferencedCount) > 0 ? result : messages,
    supersededCount,
    unreferencedCount,
    freedChars,
  }
}
