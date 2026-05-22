import type { Message } from '../api/types.js'
import type { OaiMessage } from '../api/oai-types.js'
import { CACHE_ANCHOR_MESSAGES } from './constants.js'

const STALE_PREVIEW_CHARS = 1_200
const RECENT_MESSAGES_TO_KEEP = 4

/** Proactively truncate tool_result blocks in stale rounds (N-2+). contextWindow reserved for future dynamic tuning. */
export function compactStaleRounds(messages: Message[], _contextWindow: number): Message[] {
  if (messages.length <= CACHE_ANCHOR_MESSAGES + RECENT_MESSAGES_TO_KEEP) {
    return messages
  }

  const recentStart = Math.max(CACHE_ANCHOR_MESSAGES, messages.length - RECENT_MESSAGES_TO_KEEP)
  let changed = false

  const result = messages.map((msg, idx) => {
    if (idx < CACHE_ANCHOR_MESSAGES || idx >= recentStart) return msg
    if (!Array.isArray(msg.content)) return msg

    let blockChanged = false
    const blocks = msg.content.map((block) => {
      if (block.type !== 'tool_result') return block
      if (typeof block.content !== 'string') return block
      if (block.content.length <= STALE_PREVIEW_CHARS) return block

      blockChanged = true
      const preview = block.content.slice(0, STALE_PREVIEW_CHARS)
      return {
        ...block,
        content: `${preview}\n<stale-compacted removed_chars="${block.content.length - STALE_PREVIEW_CHARS}" />`,
      }
    })

    if (!blockChanged) return msg
    changed = true
    return { ...msg, content: blocks }
  })

  return changed ? result : messages
}

/** OAI-format version: truncate tool message content in stale rounds (N-2+). */
export function compactStaleRoundsOai(messages: OaiMessage[], _contextWindow: number): OaiMessage[] {
  if (messages.length <= CACHE_ANCHOR_MESSAGES + RECENT_MESSAGES_TO_KEEP) return messages

  const recentStart = Math.max(CACHE_ANCHOR_MESSAGES, messages.length - RECENT_MESSAGES_TO_KEEP)
  let changed = false

  const result = messages.map((msg, idx) => {
    if (idx < CACHE_ANCHOR_MESSAGES || idx >= recentStart) return msg
    if (msg.role !== 'tool') return msg
    if (msg.content.length <= STALE_PREVIEW_CHARS) return msg

    changed = true
    const preview = msg.content.slice(0, STALE_PREVIEW_CHARS)
    return { ...msg, content: `${preview}\n<stale-compacted removed_chars="${msg.content.length - STALE_PREVIEW_CHARS}" />` }
  })

  return changed ? result : messages
}
