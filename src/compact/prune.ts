import type { OaiMessage } from '../api/oai-types.js'
import { CACHE_ANCHOR_MESSAGES, PRUNE_PROTECT_RECENT_MESSAGES, PRUNE_MIN_CONTENT_CHARS } from './constants.js'

// Match a trailing artifact marker like "[artifact:abc123]". When prune fires
// on a tool_result whose content carries this marker (e.g. read_file output),
// preserve it so the model can still call read_section(artifactId=...) to
// recover the full content from disk. Without this, prune wipes the marker
// and the model loses any path back to the original content.
const ARTIFACT_MARKER_REGEX = /\[artifact:([A-Za-z0-9_-]+)\]\s*$/

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

    const artifactMatch = msg.content.match(ARTIFACT_MARKER_REGEX)
    if (artifactMatch) {
      // Preserve the artifact marker so the model can recover via read_section.
      return {
        ...msg,
        content: `[pruned: ${msg.content.length} chars from tool_call ${msg.tool_call_id ?? 'unknown'}; use read_section(artifactId="${artifactMatch[1]}", section="L1-L500") to recover]\n${artifactMatch[0]}`,
      }
    }

    return {
      ...msg,
      content: `[pruned: ${msg.content.length} chars from tool_call ${msg.tool_call_id ?? 'unknown'}]`,
    }
  })

  return { messages: prunedCount > 0 ? result : messages, prunedCount, freedChars }
}
