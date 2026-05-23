import type { OaiMessage } from '../api/oai-types.js'
import { CACHE_ANCHOR_MESSAGES, PRUNE_PROTECT_RECENT_MESSAGES, PRUNE_MIN_CONTENT_CHARS } from './constants.js'

export interface PruneOptions {
  protectRecentMessages?: number
  minContentChars?: number
}

export interface PruneResult {
  messages: OaiMessage[]
  prunedCount: number
  freedChars: number
}

export function pruneStaleToolResults(
  messages: OaiMessage[],
  options: PruneOptions = {},
): PruneResult {
  const protectRecent = options.protectRecentMessages ?? PRUNE_PROTECT_RECENT_MESSAGES
  const minChars = options.minContentChars ?? PRUNE_MIN_CONTENT_CHARS

  if (messages.length <= CACHE_ANCHOR_MESSAGES + protectRecent) {
    return { messages, prunedCount: 0, freedChars: 0 }
  }

  const recentStart = messages.length - protectRecent
  let prunedCount = 0
  let freedChars = 0

  const result = messages.map((msg, idx) => {
    if (idx < CACHE_ANCHOR_MESSAGES) return msg
    if (idx >= recentStart) return msg
    if (msg.role !== 'tool') return msg
    if (msg.content.length <= minChars) return msg
    if (msg.content.startsWith('[pruned:')) return msg

    prunedCount++
    freedChars += msg.content.length
    return {
      ...msg,
      content: `[pruned: ${msg.content.length} chars from tool_call ${msg.tool_call_id ?? 'unknown'}]`,
    }
  })

  return { messages: prunedCount > 0 ? result : messages, prunedCount, freedChars }
}
