import type { OaiMessage } from '../api/oai-types.js'
import { CACHE_ANCHOR_MESSAGES } from './constants.js'

const STALE_PREVIEW_CHARS = 1_200
const RECENT_MESSAGES_TO_KEEP = 4

/** OAI-format: truncate tool message content in stale rounds (N-2+). */
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
