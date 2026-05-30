/**
 * Semantic-aware tool result pruning (Layer 1: rule-based filtering).
 *
 * Identifies and compresses low-value content in tool results:
 * - Junk directory listings (__pycache__, node_modules, .git)
 * - Test pass lists (keep only failures + summary)
 * - Edit echo (edit_file output that duplicates prior read_file)
 * - Repeated grep (same pattern multiple times → keep latest)
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

/**
 * Apply Layer 1 semantic pruning to tool results in a message array.
 * Only processes tool results within the mutable zone (after anchorCount).
 */
export function semanticPruneLayer1(
  messages: OaiMessage[],
  anchorCount: number,
): SemanticPruneResult {
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

  // Build grep dedup map: pattern|path|glob → latest index
  // Uses composite key to avoid incorrectly deduplicating greps with the
  // same pattern but different search paths or file filters.
  const grepPatterns = new Map<string, number>()
  for (let i = messages.length - 1; i >= anchorCount; i--) {
    const msg = messages[i]!
    if (msg.role !== 'tool') continue
    const info = toolCallIndex.get(msg.tool_call_id)
    if (!info) continue
    if (info.name === 'grep' || info.name === 'search') {
      try {
        const args = JSON.parse(info.args)
        const pattern = args.pattern || args.query || args.regex || ''
        if (pattern) {
          const key = [pattern, args.path ?? '', args.glob ?? ''].join('|')
          if (!grepPatterns.has(key)) {
            grepPatterns.set(key, i)
          }
        }
      } catch { /* ignore */ }
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

    // Rule 3: grep dedup — replace older grep results with reference to latest
    if ((toolName === 'grep' || toolName === 'search') && toolInfo && grepPatterns.size > 0) {
      try {
        const args = JSON.parse(toolInfo.args)
        const pattern = args.pattern || args.query || args.regex || ''
        if (pattern) {
          const key = [pattern, args.path ?? '', args.glob ?? ''].join('|')
          if (grepPatterns.get(key) !== idx) {
            newContent = `[outdated grep for "${pattern.slice(0, 40)}", see later result]`
          }
        }
      } catch { /* ignore */ }
    }

    // Skip further processing for short content
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
