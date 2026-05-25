import type { OaiMessage } from '../api/oai-types.js'
import {
  CACHE_ANCHOR_MESSAGES,
  PRUNE_PROTECT_RECENT_MESSAGES,
  PRUNE_MIN_CONTENT_CHARS,
  pruneThresholds,
} from './constants.js'

// Match an artifact marker at the END of the tool result content string.
// All tools producing artifact refs MUST place "[artifact:XYZ]" as the last
// token — any usage instructions, summaries, or other suffixes go BEFORE it.
// See docs/superpowers/plans/2026-05-24-工具输出 artifact 标记格式统一与窗口感知预算.md.
// When prune fires on a tool_result carrying this marker, we preserve it so
// the model can still call read_section(artifactId=...) to recover the full
// content from disk. Without this, prune wipes the marker and the model
// loses any path back to the original content.
const ARTIFACT_MARKER_REGEX = /\[artifact:([A-Za-z0-9_-]+)\]\s*$/

export interface PruneOptions {
  protectRecentMessages?: number
  minContentChars?: number
  /** When set, derive protectRecentMessages and minContentChars via
   * `pruneThresholds(contextWindow)`. Explicit `protectRecentMessages` /
   * `minContentChars` still override. */
  contextWindow?: number
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
  const windowDefaults = options.contextWindow !== undefined
    ? pruneThresholds(options.contextWindow)
    : { protectRecent: PRUNE_PROTECT_RECENT_MESSAGES, minChars: PRUNE_MIN_CONTENT_CHARS }

  const protectRecent = options.protectRecentMessages ?? windowDefaults.protectRecent
  const minChars = options.minContentChars ?? windowDefaults.minChars

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
