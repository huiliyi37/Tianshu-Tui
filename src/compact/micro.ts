import type { OaiMessage } from '../api/oai-types.js'
import { KEEP_RECENT_MESSAGES, CACHE_ANCHOR_MESSAGES, compactThresholds } from './constants.js'
import { groupIntoRoundsOai } from '../context/rounds.js'

const CHARS_PER_TOKEN = 4

function compactToolMessage(msg: OaiMessage, contextWindow: number): { msg: OaiMessage; changed: boolean } {
  if (msg.role !== 'tool') return { msg, changed: false }
  const previewChars = Math.max(1_200, compactThresholds(contextWindow).toolResultMaxTokens * CHARS_PER_TOKEN)
  if (msg.content.length <= previewChars) return { msg, changed: false }
  const stub = `<microcompacted tool_result original_chars="${msg.content.length}">\n${msg.content.slice(0, previewChars)}\n</microcompacted tool_result>`
  if (stub.length >= msg.content.length) return { msg, changed: false }
  return { msg: { ...msg, content: stub }, changed: true }
}

function compactOaiReasoning(_msg: OaiMessage): { msg: OaiMessage; changed: boolean } {
  // reasoning_content is always passed back intact — truncation savings are
  // negligible once prefix cache kicks in, and incomplete reasoning degrades
  // model quality on providers that require it (MiMo, DeepSeek).
  return { msg: _msg, changed: false }
}

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

export function estimateOaiTokens(messages: OaiMessage[]): number {
  let total = 0
  for (const msg of messages) {
    total += estimateOaiMessageTokens(msg)
  }
  return total
}

export function microCompactOai(
  messages: OaiMessage[],
  contextWindow: number,
  estimatedTokens: number,
): { messages: OaiMessage[]; truncated: number } {
  const recentStart = Math.max(0, messages.length - KEEP_RECENT_MESSAGES)

  let compactedCount = 0
  const shortened = messages.map((msg, msgIdx) => {
    const isRecent = msgIdx >= recentStart

    const toolResult = compactToolMessage(msg, contextWindow)
    if (toolResult.changed) { compactedCount++; return toolResult.msg }

    if (!isRecent && msgIdx >= CACHE_ANCHOR_MESSAGES) {
      const reasonResult = compactOaiReasoning(msg)
      if (reasonResult.changed) { compactedCount++; return reasonResult.msg }
    }

    return msg
  })

  let currentTokens = compactedCount > 0 ? estimateOaiTokens(shortened) : estimatedTokens

  if (currentTokens <= contextWindow || messages.length <= KEEP_RECENT_MESSAGES + CACHE_ANCHOR_MESSAGES) {
    return { messages: shortened, truncated: compactedCount }
  }

  const anchorEnd = CACHE_ANCHOR_MESSAGES
  const tier2RecentStart = Math.max(0, shortened.length - KEEP_RECENT_MESSAGES)
  const rounds = groupIntoRoundsOai(shortened)
  const removeIndexes = new Set<number>()

  for (const round of rounds) {
    if (round.startMessageIndex >= anchorEnd && round.endMessageIndex <= tier2RecentStart && round.apiInvariant === 'ok') {
      const roundTokens = round.tokenEstimate
      if (currentTokens - roundTokens <= contextWindow * 0.7) continue
      for (let idx = round.startMessageIndex; idx < round.endMessageIndex; idx += 1) {
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

  return { messages: shortened, truncated: compactedCount }
}
