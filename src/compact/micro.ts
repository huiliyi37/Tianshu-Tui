import type { Message } from '../api/types.js'
import { KEEP_RECENT_MESSAGES, CACHE_ANCHOR_MESSAGES, compactThresholds } from './constants.js'
import { groupIntoRounds } from '../context/rounds.js'

const CHARS_PER_TOKEN = 4

function compactToolResultBlock(block: any, contextWindow: number): { block: any; changed: boolean } {
  if (block.type !== 'tool_result') return { block, changed: false }
  if (typeof block.content !== 'string') return { block, changed: false }
  const previewChars = Math.max(1_200, compactThresholds(contextWindow).toolResultMaxTokens * CHARS_PER_TOKEN)
  if (block.content.length <= previewChars) return { block, changed: false }
  const stub = `<microcompacted tool_result original_chars="${block.content.length}">\n${block.content.slice(0, previewChars)}\n</microcompacted tool_result>`
  if (stub.length >= block.content.length) return { block, changed: false }
  return { block: { ...block, content: stub }, changed: true }
}

/**
 * MicroCompact: lightweight round-safe truncation without API calls.
 *
 * Two-tier strategy:
 *   Tier 1: shorten large tool_result content blocks (zero API cost)
 *   Tier 2: remove complete safe rounds from the middle
 *
 * Always preserves:
 *   - First CACHE_ANCHOR_MESSAGES (cache anchor — preserves prefix structure)
 *   - Last KEEP_RECENT_MESSAGES (recent context)
 *
 * Returns a new messages array (immutable) and the number of truncated messages.
 */
export function microCompact(
  messages: Message[],
  contextWindow: number,
  estimatedTokens: number,
): { messages: Message[]; truncated: number } {
  // Tier 1: shorten large tool_result content (zero API cost)
  let compactedCount = 0
  const shortened = messages.map(msg => {
    if (!Array.isArray(msg.content)) return msg
    let modified = false
    const blocks = msg.content.map((block: any) => {
      const result = compactToolResultBlock(block, contextWindow)
      if (result.changed) { compactedCount++; modified = true }
      return result.block
    })
    return modified ? { ...msg, content: blocks } : msg
  })

  let currentTokens = compactedCount > 0 ? estimateTokens(shortened) : estimatedTokens

  if (currentTokens <= contextWindow || messages.length <= KEEP_RECENT_MESSAGES + CACHE_ANCHOR_MESSAGES) {
    return { messages: shortened, truncated: compactedCount }
  }

  // Tier 2: remove complete safe rounds from the middle
  const anchorEnd = CACHE_ANCHOR_MESSAGES
  const recentStart = Math.max(0, shortened.length - KEEP_RECENT_MESSAGES)
  const rounds = groupIntoRounds(shortened)
  const removeIndexes = new Set<number>()

  for (const round of rounds) {
    // Only remove rounds that are fully in the removable middle zone
    if (round.startMessageIndex >= anchorEnd && round.endMessageIndex <= recentStart && round.apiInvariant === 'ok') {
      const roundTokens = round.tokenEstimate
      if (currentTokens - roundTokens <= contextWindow * 0.7) continue // keep some headroom
      for (let idx = round.startMessageIndex; idx < round.endMessageIndex; idx++) {
        removeIndexes.add(idx)
      }
      currentTokens -= roundTokens
      compactedCount += round.endMessageIndex - round.startMessageIndex
      if (currentTokens <= contextWindow) break
    }
  }

  if (removeIndexes.size > 0) {
    const result = shortened.filter((_, idx) => !removeIndexes.has(idx))
    return { messages: result, truncated: compactedCount }
  }

  // Fallback: if no complete rounds could be removed, keep the shortened version
  return { messages: shortened, truncated: compactedCount }
}

/** Token estimation for a single message, accounting for CJK vs ASCII character density. */
export function estimateMessageTokens(msg: Message): number {
  const content = typeof msg.content === 'string'
    ? msg.content
    : JSON.stringify(msg.content)

  let asciiChars = 0
  let cjkChars = 0
  for (const ch of content) {
    const code = ch.codePointAt(0) ?? 0
    if (
      (code >= 0x4E00 && code <= 0x9FFF) ||
      (code >= 0x3400 && code <= 0x4DBF) ||
      (code >= 0x20000 && code <= 0x2A6DF) ||
      (code >= 0x3040 && code <= 0x309F) ||
      (code >= 0x30A0 && code <= 0x30FF) ||
      (code >= 0xAC00 && code <= 0xD7AF)
    ) {
      cjkChars++
    } else {
      asciiChars++
    }
  }
  return Math.ceil(asciiChars / 4) + Math.ceil(cjkChars / 1.5)
}

/** Token estimation accounting for CJK vs ASCII character density. */
export function estimateTokens(messages: Message[]): number {
  let total = 0
  for (const msg of messages) {
    total += estimateMessageTokens(msg)
  }
  return total
}
