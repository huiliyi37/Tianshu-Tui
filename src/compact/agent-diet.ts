/**
 * AgentDiet: classify and reduce trajectory segments.
 *
 * Based on FSE 2026 paper — removes redundant, expired, and useless
 * information from agent trajectories for 39-59% token reduction.
 */

export interface OaiMessage {
  role: 'user' | 'assistant' | 'system' | 'tool'
  content: string
  tool_call_id?: string
  tool_calls?: Array<{ id: string; function: { name: string; arguments: string } }>
}

export interface DietOptions {
  protectRecentMessages?: number
}

export interface DietResult {
  messages: OaiMessage[]
  removedCount: number
  freedChars: number
  categories: { redundant: number; expired: number; useless: number }
}

const ANCHOR_MESSAGES = 2

interface ExtractedPath {
  path: string
  /** read_file offset (1-based line), undefined = start of file */
  offset?: number
  /** read_file limit (max lines), undefined = to end of file */
  limit?: number
}

interface ReadEntry {
  index: number
  offset?: number
  limit?: number
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

export function applyAgentDiet(messages: OaiMessage[], options: DietOptions = {}): DietResult {
  const protectRecent = options.protectRecentMessages ?? 6

  if (messages.length <= ANCHOR_MESSAGES + protectRecent) {
    return { messages, removedCount: 0, freedChars: 0, categories: { redundant: 0, expired: 0, useless: 0 } }
  }

  const recentStart = messages.length - protectRecent
  const categories = { redundant: 0, expired: 0, useless: 0 }
  let freedChars = 0

  // Pass 1: index file reads, edits, and failed retries
  const fileReads = new Map<string, ReadEntry[]>()
  const fileEdits = new Map<string, number[]>()
  const failedRetries = new Set<number>()

  for (let i = ANCHOR_MESSAGES; i < recentStart; i++) {
    const msg = messages[i]!

    if (msg.role === 'tool') {
      const ep = extractPath(msg, messages)
      if (ep) {
        const reads = fileReads.get(ep.path) ?? []
        reads.push({ index: i, offset: ep.offset, limit: ep.limit })
        fileReads.set(ep.path, reads)
      }

      // Detect failed-then-retried
      if (isFailedResult(msg) && i + 2 < messages.length) {
        const nextTool = messages[i + 2]
        if (messages[i + 1]?.role === 'assistant' && nextTool?.role === 'tool' && !isFailedResult(nextTool)) {
          failedRetries.add(i)
        }
      }
    }

    if (msg.role === 'assistant' && msg.tool_calls) {
      for (const tc of msg.tool_calls) {
        if (tc.function.name === 'edit_file' || tc.function.name === 'write_file') {
          try {
            const args = JSON.parse(tc.function.arguments)
            const path = args.file_path || args.path
            if (path) {
              const edits = fileEdits.get(path) ?? []
              edits.push(i)
              fileEdits.set(path, edits)
            }
          } catch {}
        }
      }
    }
  }

  // Pass 2: apply reductions
  const result = messages.map((msg, idx) => {
    if (idx < ANCHOR_MESSAGES || idx >= recentStart) return msg
    if (msg.role !== 'tool') return msg
    if (msg.content.startsWith('[diet:')) return msg

    if (failedRetries.has(idx)) {
      categories.useless++
      freedChars += msg.content.length
      return { ...msg, content: '[diet:useless] retried successfully' }
    }

    const ep = extractPath(msg, messages)
    if (ep) {
      const reads = fileReads.get(ep.path) ?? []
      // Check if any later read of the same file has a range that contains
      // the current read's range. Full reads (no offset/limit) contain all
      // ranges; partial reads only contain overlapping/subsumed ranges.
      const laterReads = reads.filter(r => r.index > idx)
      if (laterReads.some(r => rangeContains(r, ep))) {
        categories.redundant++
        freedChars += msg.content.length
        return { ...msg, content: `[diet:redundant] re-read later` }
      }

      const edits = fileEdits.get(ep.path) ?? []
      if (edits.some(e => e > idx)) {
        categories.expired++
        freedChars += msg.content.length
        return { ...msg, content: `[diet:expired] file modified later` }
      }
    }

    return msg
  })

  const removedCount = categories.redundant + categories.expired + categories.useless
  return { messages: removedCount > 0 ? result : messages, removedCount, freedChars, categories }
}

function extractPath(msg: OaiMessage, allMessages: OaiMessage[]): ExtractedPath | undefined {
  if (!msg.tool_call_id) return undefined
  for (let i = allMessages.indexOf(msg) - 1; i >= 0; i--) {
    const prev = allMessages[i]!
    if (prev.role !== 'assistant' || !prev.tool_calls) continue
    const tc = prev.tool_calls.find(t => t.id === msg.tool_call_id)
    if (!tc) continue
    if (tc.function.name === 'read_file' || tc.function.name === 'grep' || tc.function.name === 'glob') {
      try {
        const args = JSON.parse(tc.function.arguments)
        const path = args.file_path || args.path || args.pattern
        if (!path) return undefined
        if (tc.function.name === 'read_file') {
          return { path, offset: parseOptionalInt(args.offset), limit: parseOptionalInt(args.limit) }
        }
        return { path }
      } catch { return undefined }
    }
    return undefined
  }
  return undefined
}

function isFailedResult(msg: OaiMessage): boolean {
  return msg.content.startsWith('Error:') || msg.content.startsWith('error:') ||
    msg.content.includes('ENOENT') || msg.content.includes('Permission denied')
}
