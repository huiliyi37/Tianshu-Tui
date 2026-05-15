import type { Message } from '../api/types.js'
import { KEEP_RECENT_MESSAGES, CACHE_ANCHOR_MESSAGES } from './constants.js'

/**
 * MicroCompact: lightweight truncation without API calls.
 *
 * When total estimated tokens exceed the context window, truncate the
 * middle messages while keeping:
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
  if (estimatedTokens <= contextWindow || messages.length <= KEEP_RECENT_MESSAGES + CACHE_ANCHOR_MESSAGES) {
    return { messages, truncated: 0 }
  }

  const anchor = messages.slice(0, CACHE_ANCHOR_MESSAGES)
  const recent = messages.slice(-KEEP_RECENT_MESSAGES)
  const middle = messages.slice(CACHE_ANCHOR_MESSAGES, -KEEP_RECENT_MESSAGES)

  let totalTokens = estimatedTokens
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
