import type { Message } from '../api/types.js'
import { KEEP_RECENT_MESSAGES, CACHE_ANCHOR_MESSAGES } from './constants.js'

/**
 * MicroCompact: lightweight truncation without API calls.
 *
 * When total estimated tokens exceed the context window, truncate the
 * middle messages while keeping:
 *   - First CACHE_ANCHOR_MESSAGES (cache anchor — preserves prefix structure)
 *   - Last KEEP_RECENT_MESSAGES (recent context)
 * This preserves [System][Tools][Volatile][User1][Asst1] in DeepSeek's
 * prefix cache after compaction.
 *
 * Returns a new messages array (immutable) and the number of truncated messages.
 */
export function microCompact(
  messages: Message[],
  contextWindow: number,
  estimatedTokens: number,
): { messages: Message[]; truncated: number } {
  if (estimatedTokens <= contextWindow || messages.length <= KEEP_RECENT_MESSAGES + CACHE_ANCHOR_MESSAGES) {
    return { messages, truncated: 0 }
  }

  // Compute total tokens once, then subtract each removed message's tokens
  const anchor = messages.slice(0, CACHE_ANCHOR_MESSAGES)
  const recent = messages.slice(-KEEP_RECENT_MESSAGES)
  const middle = messages.slice(CACHE_ANCHOR_MESSAGES, -KEEP_RECENT_MESSAGES)

  let totalTokens = estimateTokens(messages)
  // Subtract anchor and recent tokens — they're always kept
  for (const m of anchor) totalTokens -= estimateMessageTokens(m)
  for (const m of recent) totalTokens -= estimateMessageTokens(m)

  // Remove from the START of middle (oldest first) until under budget
  let removeCount = 0
  while (removeCount < middle.length && totalTokens > contextWindow) {
    totalTokens -= estimateMessageTokens(middle[removeCount]!)
    removeCount++
  }

  const keptMiddle = middle.slice(removeCount)
  return {
    messages: [...anchor, ...keptMiddle, ...recent],
    truncated: removeCount,
  }
}

/** Token estimation for a single message, accounting for CJK vs ASCII character density. */
export function estimateMessageTokens(msg: Message): number {
  const content = typeof msg.content === 'string'
    ? msg.content
    : JSON.stringify(msg.content)

  // Count CJK characters separately — they're ~2 tokens each, but
  // BPE on mixed text averages to ~1.5 chars per token.
  let asciiChars = 0
  let cjkChars = 0
  for (const ch of content) {
    const code = ch.codePointAt(0) ?? 0
    if (
      (code >= 0x4E00 && code <= 0x9FFF) ||  // CJK Unified Ideographs
      (code >= 0x3400 && code <= 0x4DBF) ||  // CJK Extension A
      (code >= 0x20000 && code <= 0x2A6DF) || // CJK Extension B
      (code >= 0x3040 && code <= 0x309F) ||  // Hiragana
      (code >= 0x30A0 && code <= 0x30FF) ||  // Katakana
      (code >= 0xAC00 && code <= 0xD7AF)     // Hangul
    ) {
      cjkChars++
    } else {
      asciiChars++
    }
  }
  return Math.ceil(asciiChars / 4) + Math.ceil(cjkChars / 1.5)
}

/** Token estimation accounting for CJK vs ASCII character density.
 *
 *  - ASCII/Latin characters: ~4 chars per token
 *  - CJK / Hangul characters: ~1.5 chars per token (~2 tokens per char in practice,
 *    but Claude uses BPE so mixed text averages to ~1.5)
 */
export function estimateTokens(messages: Message[]): number {
  let total = 0
  for (const msg of messages) {
    total += estimateMessageTokens(msg)
  }
  return total
}
