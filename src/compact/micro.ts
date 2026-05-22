import type { Message } from '../api/types.js'
import type { OaiMessage } from '../api/oai-types.js'
import { KEEP_RECENT_MESSAGES, CACHE_ANCHOR_MESSAGES, compactThresholds } from './constants.js'
import { groupIntoRounds } from '../context/rounds.js'

const CHARS_PER_TOKEN = 4

/** Max chars to keep when truncating thinking blocks in historical (non-recent) messages */
const THINKING_TRUNCATE_CHARS = 500

/**
 * Truncate a thinking block if it exceeds THINKING_TRUNCATE_CHARS.
 * Keeps the beginning (which contains the model's conclusion/plan) and
 * a marker showing how much was removed. Only applied to non-recent messages.
 */
function compactThinkingBlock(block: any): { block: any; changed: boolean } {
  if (block.type !== 'thinking') return { block, changed: false }
  if (typeof block.thinking !== 'string') return { block, changed: false }
  if (block.thinking.length <= THINKING_TRUNCATE_CHARS) return { block, changed: false }
  const truncated = block.thinking.slice(0, THINKING_TRUNCATE_CHARS)
  const stub = `${truncated}\n<thinking-compacted removed_chars="${block.thinking.length - THINKING_TRUNCATE_CHARS}" />`
  // Safety: don't replace if stub is somehow longer
  if (stub.length >= block.thinking.length) return { block, changed: false }
  return { block: { ...block, thinking: stub }, changed: true }
}

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
 *   Tier 1: shorten large tool_result + thinking blocks (zero API cost)
 *   Tier 2: remove complete safe rounds from the middle
 *
 * Always preserves:
 *   - First CACHE_ANCHOR_MESSAGES (cache anchor — preserves prefix structure)
 *   - Last KEEP_RECENT_MESSAGES (recent context — thinking blocks kept intact)
 *
 * Returns a new messages array (immutable) and the number of truncated messages.
 */
export function microCompact(
  messages: Message[],
  contextWindow: number,
  estimatedTokens: number,
): { messages: Message[]; truncated: number } {
  const recentStart = Math.max(0, messages.length - KEEP_RECENT_MESSAGES)

  // Tier 1: shorten large tool_result content + truncate thinking in history
  let compactedCount = 0
  const shortened = messages.map((msg, msgIdx) => {
    if (!Array.isArray(msg.content)) return msg
    // Skip thinking truncation for recent messages
    const isRecent = msgIdx >= recentStart
    let modified = false
    const blocks = msg.content.map((block: any) => {
      // Tool result compaction applies to all messages
      const toolResult = compactToolResultBlock(block, contextWindow)
      if (toolResult.changed) { compactedCount++; modified = true; return toolResult.block }
      // Thinking compaction only for non-recent, non-anchor messages
      if (!isRecent && msgIdx >= CACHE_ANCHOR_MESSAGES) {
        const thinkResult = compactThinkingBlock(block)
        if (thinkResult.changed) { compactedCount++; modified = true; return thinkResult.block }
      }
      return block
    })
    return modified ? { ...msg, content: blocks } : msg
  })

  let currentTokens = compactedCount > 0 ? estimateTokens(shortened) : estimatedTokens

  if (currentTokens <= contextWindow || messages.length <= KEEP_RECENT_MESSAGES + CACHE_ANCHOR_MESSAGES) {
    return { messages: shortened, truncated: compactedCount }
  }

  // Tier 2: remove complete safe rounds from the middle
  const anchorEnd = CACHE_ANCHOR_MESSAGES
  const tier2RecentStart = Math.max(0, shortened.length - KEEP_RECENT_MESSAGES)
  const rounds = groupIntoRounds(shortened)
  const removeIndexes = new Set<number>()

  for (const round of rounds) {
    // Only remove rounds that are fully in the removable middle zone
    if (round.startMessageIndex >= anchorEnd && round.endMessageIndex <= tier2RecentStart && round.apiInvariant === 'ok') {
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

// ─── OAI-format variants ───

/** OAI version: compact tool message content. */
function compactToolMessage(msg: OaiMessage, contextWindow: number): { msg: OaiMessage; changed: boolean } {
  if (msg.role !== 'tool') return { msg, changed: false }
  const previewChars = Math.max(1_200, compactThresholds(contextWindow).toolResultMaxTokens * CHARS_PER_TOKEN)
  if (msg.content.length <= previewChars) return { msg, changed: false }
  const stub = `<microcompacted tool_result original_chars="${msg.content.length}">\n${msg.content.slice(0, previewChars)}\n</microcompacted tool_result>`
  if (stub.length >= msg.content.length) return { msg, changed: false }
  return { msg: { ...msg, content: stub }, changed: true }
}

/** OAI version: truncate reasoning_content in assistant messages for non-recent turns. */
function compactOaiReasoning(msg: OaiMessage, _isRecent: boolean): { msg: OaiMessage; changed: boolean } {
  if (msg.role !== 'assistant') return { msg, changed: false }
  if (!msg.reasoning_content) return { msg, changed: false }
  if (msg.reasoning_content.length <= THINKING_TRUNCATE_CHARS) return { msg, changed: false }
  const truncated = msg.reasoning_content.slice(0, THINKING_TRUNCATE_CHARS)
  const stub = `${truncated}\n<thinking-compacted removed_chars="${msg.reasoning_content.length - THINKING_TRUNCATE_CHARS}" />`
  if (stub.length >= msg.reasoning_content.length) return { msg, changed: false }
  return { msg: { ...msg, reasoning_content: stub }, changed: true }
}

/** OAI-format token estimation. */
export function estimateOaiMessageTokens(msg: OaiMessage): number {
  let content: string
  if (msg.role === 'assistant' && msg.tool_calls) {
    content = (msg.content ?? '') + JSON.stringify(msg.tool_calls)
  } else if (msg.role === 'assistant' && msg.reasoning_content) {
    content = (msg.content ?? '') + msg.reasoning_content
  } else if (msg.role === 'assistant') {
    content = msg.content ?? ''
  } else {
    content = msg.content
  }

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

/** OAI batch token estimation. */
export function estimateOaiTokens(messages: OaiMessage[]): number {
  let total = 0
  for (const msg of messages) {
    total += estimateOaiMessageTokens(msg)
  }
  return total
}

/**
 * OAI-format MicroCompact: lightweight round-safe truncation without API calls.
 *
 * Same two-tier strategy as microCompact but operates on OaiMessage[].
 */
export function microCompactOai(
  messages: OaiMessage[],
  contextWindow: number,
  estimatedTokens: number,
): { messages: OaiMessage[]; truncated: number } {
  const recentStart = Math.max(0, messages.length - KEEP_RECENT_MESSAGES)

  // Tier 1: shorten large tool messages + reasoning_content in history
  let compactedCount = 0
  const shortened = messages.map((msg, msgIdx) => {
    const isRecent = msgIdx >= recentStart

    // Tool message compaction applies to all messages
    const toolResult = compactToolMessage(msg, contextWindow)
    if (toolResult.changed) { compactedCount++; return toolResult.msg }

    // Reasoning compaction only for non-recent, non-anchor messages
    if (!isRecent && msgIdx >= CACHE_ANCHOR_MESSAGES) {
      const reasonResult = compactOaiReasoning(msg, isRecent)
      if (reasonResult.changed) { compactedCount++; return reasonResult.msg }
    }

    return msg
  })

  let currentTokens = compactedCount > 0 ? estimateOaiTokens(shortened) : estimatedTokens

  if (currentTokens <= contextWindow || messages.length <= KEEP_RECENT_MESSAGES + CACHE_ANCHOR_MESSAGES) {
    return { messages: shortened, truncated: compactedCount }
  }

  // Tier 2: remove complete rounds from the middle
  // For OAI format, we need to detect rounds differently
  const anchorEnd = CACHE_ANCHOR_MESSAGES
  const tier2RecentStart = Math.max(0, shortened.length - KEEP_RECENT_MESSAGES)
  const removeIndexes = new Set<number>()

  // Simple round detection for OAI: scan for user->assistant->tool* patterns
  let i = anchorEnd
  while (i < tier2RecentStart) {
    if (shortened[i]!.role === 'user') {
      // Find end of this round
      let roundEnd = i + 1
      while (roundEnd < tier2RecentStart) {
        const r = shortened[roundEnd]!
        if (r.role === 'user') break
        roundEnd++
      }

      // Check if round is complete (ends with assistant or tool)
      const lastInRound = shortened[roundEnd - 1]!
      if (lastInRound.role === 'assistant' || lastInRound.role === 'tool') {
        // Estimate round tokens
        let roundTokens = 0
        for (let idx = i; idx < roundEnd; idx++) {
          roundTokens += estimateOaiMessageTokens(shortened[idx]!)
        }

        if (currentTokens - roundTokens > contextWindow * 0.7) {
          for (let idx = i; idx < roundEnd; idx++) {
            removeIndexes.add(idx)
          }
          currentTokens -= roundTokens
          compactedCount += roundEnd - i
          if (currentTokens <= contextWindow) break
        }
      }

      i = roundEnd
    } else {
      i++
    }
  }

  if (removeIndexes.size > 0) {
    const result = shortened.filter((_, idx) => !removeIndexes.has(idx))
    return { messages: result, truncated: compactedCount }
  }

  return { messages: shortened, truncated: compactedCount }
}
