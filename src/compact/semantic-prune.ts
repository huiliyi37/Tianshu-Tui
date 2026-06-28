/**
 * Semantic-aware tool result pruning (Layer 1: rule-based filtering).
 *
 * Identifies and compresses low-value content in tool results:
 * - Junk directory listings (__pycache__, node_modules, .git)
 * - Test pass lists (keep only failures + summary)
 * - Repeated queries (same pattern+path+glob → keep latest)
 *
 * All pruning replaces message CONTENT in place — never splices messages out.
 * Splicing shifts all subsequent message indices, busting the exact-prefix
 * cache: every message after the splice point must be re-sent at cacheWrite
 * premium. Content replacement keeps the message array length stable so the
 * cache prefix stays byte-aligned.
 */
import type { OaiMessage, OaiAssistantMessage } from '../api/oai-types.js'

/** Junk path patterns — directory listings containing these are low-value. */
const JUNK_DIR_RE = /(?:__pycache__|node_modules|\.git\/|\.venv|\.mypy_cache|\.pytest_cache|\.next\/|dist\/|build\/|\.tox)/

/** Lines that are just passing test markers. */
const TEST_PASS_RE = /^\s*[✓✔●◌⊙].*\(\d+\s*ms\)\s*$|^\s*(?:PASS|✓|✔)\s+.+/

/** Prune junk directory listings — replace bulk entries with a summary. */
function pruneJunkDirs(content: string): string {
  const lines = content.split('\n')
  if (lines.length < 5) return content

  const junkLines = lines.filter(l => JUNK_DIR_RE.test(l))
  if (junkLines.length < 3) return content

  const kept = lines.filter(l => !JUNK_DIR_RE.test(l))
  kept.push(`[${junkLines.length} junk directory entries removed]`)
  return kept.join('\n')
}

/** Prune test output — keep failures and summary, remove individual pass lines. */
function pruneTestOutput(content: string): string {
  if (!content.includes('pass') && !content.includes('✓') && !content.includes('✔')) return content
  const lines = content.split('\n')
  if (lines.length < 10) return content

  const passLines: number[] = []
  for (let i = 0; i < lines.length; i++) {
    if (TEST_PASS_RE.test(lines[i]!)) passLines.push(i)
  }
  if (passLines.length < 5) return content

  const kept = lines.filter((_, i) => !passLines.includes(i))
  kept.push(`[${passLines.length} passing test lines removed]`)
  return kept.join('\n')
}

export interface SemanticPruneResult {
  messages: OaiMessage[]
  prunedCount: number
  savedChars: number
}

const QUERY_TOOLS = new Set(['grep', 'glob', 'read_file', 'semantic_search', 'search'])

interface QueryKeyResult {
  /** Dedup key: `toolName:pattern|path|glob|paths`. */
  compound: string
  /** Pattern for the placeholder message. */
  pattern: string
}

/** Extract a query dedup key from tool call args. */
function queryKey(toolName: string, args: Record<string, unknown>): QueryKeyResult | null {
  if (!QUERY_TOOLS.has(toolName)) return null

  switch (toolName) {
    case 'grep':
    case 'glob':
    case 'semantic_search':
    case 'search': {
      const pattern = typeof args.pattern === 'string' ? args.pattern
        : typeof args.query === 'string' ? args.query
        : typeof args.regex === 'string' ? args.regex
        : undefined
      if (!pattern) return null
      const path = typeof args.path === 'string' ? args.path : ''
      const glob = typeof args.glob === 'string' ? args.glob : ''
      const paths = Array.isArray(args.paths)
        ? (args.paths as unknown[]).filter((p): p is string => typeof p === 'string').join(',')
        : ''
      return { compound: `${toolName}:${[pattern, path, glob, paths].join('|')}`, pattern }
    }
    case 'read_file': {
      const filePath = typeof args.file_path === 'string' ? args.file_path : ''
      if (!filePath) return null
      const offset = typeof args.offset === 'number' ? `:${args.offset}` : ''
      const limit = typeof args.limit === 'number' ? `:${args.limit}` : ''
      return { compound: `${toolName}:${filePath}${offset}${limit}`, pattern: filePath }
    }
    default:
      return null
  }
}

/**
 * Apply Layer 1 semantic pruning to tool results in a message array.
 * Only processes tool results within the mutable zone (after anchorCount).
 *
 * **Cache-safe**: replaces message content, never splices. The returned array
 * has the same length as the input; pruned messages get placeholder content.
 * When `prunedCount === 0`, returns the original array reference (no copy).
 */
export function semanticPruneLayer1(
  messages: OaiMessage[],
  anchorCount: number,
): SemanticPruneResult {
  if (messages.length <= anchorCount) return { messages, prunedCount: 0, savedChars: 0 }

  let prunedCount = 0
  let savedChars = 0

  // Pre-build toolCallId → { name, args } index (O(n) replaces O(n²) resolveToolName)
  const toolCallIndex = new Map<string, { name: string; args: string }>()
  for (let i = anchorCount; i < messages.length; i++) {
    const msg = messages[i]!
    if (msg.role === 'assistant') {
      const aMsg = msg as OaiAssistantMessage
      if (aMsg.tool_calls) {
        for (const tc of aMsg.tool_calls) {
          toolCallIndex.set(tc.id, { name: tc.function.name, args: tc.function.arguments })
        }
      }
    }
  }

  // Build query dedup map: compound key → latest index
  // Walk tail-to-head so each key maps to its greatest (latest) occurrence.
  const latestByKey = new Map<string, number>()
  for (let i = messages.length - 1; i >= anchorCount; i--) {
    const msg = messages[i]!
    if (msg.role !== 'tool') continue
    const info = toolCallIndex.get(msg.tool_call_id)
    if (!info) continue
    let args: Record<string, unknown> = {}
    try { args = JSON.parse(info.args) } catch { continue }
    const key = queryKey(info.name, args)
    if (!key) continue
    if (!latestByKey.has(key.compound)) {
      latestByKey.set(key.compound, i)
    }
  }

  const result = messages.map((msg, idx) => {
    if (idx < anchorCount) return msg
    if (msg.role !== 'tool') return msg
    if (msg.content.startsWith('[')) return msg // already processed

    const toolInfo = toolCallIndex.get(msg.tool_call_id)
    const toolName = toolInfo?.name
    let newContent = msg.content
    const origLen = newContent.length

    // Rule 3: query dedup — replace older duplicate query results with placeholder
    if (toolInfo && latestByKey.size > 0) {
      let args: Record<string, unknown> = {}
      try { args = JSON.parse(toolInfo.args) } catch { /* skip dedup for this msg */ }
      const key = queryKey(toolName!, args)
      if (key && latestByKey.get(key.compound) !== idx) {
        newContent = `[outdated ${toolName} for "${key.pattern.slice(0, 40)}", see later result]`
      }
    }

    // Skip further processing for short content (unless already deduped)
    if (origLen < 200 && newContent === msg.content) return msg

    // Rule 1: Junk directory pruning (list_dir, glob, find results)
    if (toolName === 'list_dir' || toolName === 'glob' || toolName === 'find_files') {
      newContent = pruneJunkDirs(newContent)
    }

    // Rule 2: Test output pruning (bash tool running tests)
    if (toolName === 'bash') {
      newContent = pruneTestOutput(newContent)
    }

    if (newContent.length < origLen) {
      prunedCount++
      savedChars += origLen - newContent.length
      return { ...msg, content: newContent }
    }
    return msg
  })

  return { messages: prunedCount > 0 ? result : messages, prunedCount, savedChars }
}

/**
 * Backward-compatible alias. Engine.ts imports this name.
 *
 * Cache-safe: replaces message content in-place within the array (via the
 * returned `messages`), never splices. Callers should use the returned
 * `messages` array rather than relying on mutation of the input.
 */
export function pruneOutdatedQueryResults(
  messages: OaiMessage[],
  anchorCount: number,
): SemanticPruneResult {
  return semanticPruneLayer1(messages, anchorCount)
}
