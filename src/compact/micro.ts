import type { Message } from '../api/types.js'
import { KEEP_RECENT_MESSAGES } from './constants.js'

/**
 * MicroCompact: lightweight truncation without API calls.
 *
 * When total estimated tokens exceed the context window, truncate the
 * oldest messages while keeping the most recent KEEP_RECENT_MESSAGES.
 * This does NOT modify system prompt, so prefix cache stays intact.
 *
 * Returns a new messages array (immutable) and the number of truncated messages.
 */
export function microCompact(
  messages: Message[],
  contextWindow: number,
  estimatedTokens: number,
): { messages: Message[]; truncated: number } {
  if (estimatedTokens <= contextWindow || messages.length <= KEEP_RECENT_MESSAGES) {
    return { messages, truncated: 0 }
  }

  // Iteratively remove oldest messages until under context window.
  // KEEP_RECENT_MESSAGES is the floor — never truncate below this.
  let removed = 0
  const kept = [...messages]
  while (kept.length > KEEP_RECENT_MESSAGES && estimateTokens(kept) > contextWindow) {
    kept.shift()
    removed++
  }

  return { messages: kept, truncated: removed }
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
    total += Math.ceil(asciiChars / 4) + Math.ceil(cjkChars / 1.5)
  }
  return total
}
