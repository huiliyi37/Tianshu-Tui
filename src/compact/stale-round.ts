import type { OaiMessage } from '../api/oai-types.js'
import { CACHE_ANCHOR_MESSAGES, staleRoundThresholds } from './constants.js'

// Match an artifact marker at the END of the tool result content string.
// All tools producing artifact refs MUST place "[artifact:XYZ]" as the last
// token — any usage instructions, summaries, or other suffixes go BEFORE it.
// See docs/superpowers/plans/2026-05-24-工具输出 artifact 标记格式统一与窗口感知预算.md.
// We preserve this marker when truncating so the model can still call
// read_section(artifactId=...) to retrieve the original content.
const ARTIFACT_MARKER_REGEX = /\[artifact:([A-Za-z0-9_-]+)\]\s*$/

/** OAI-format: truncate tool message content in stale rounds (N-2+).
 *
 * `recentToKeep` and `previewChars` scale with `contextWindow` via
 * `staleRoundThresholds` — a 1M window keeps 30 recent messages and a 30K
 * preview, while a 64K window keeps the legacy 4 / 1.2K. Callers may still
 * pass `previewChars` explicitly to override.
 */
export function compactStaleRoundsOai(
  messages: OaiMessage[],
  contextWindow: number,
  previewCharsOverride?: number,
): OaiMessage[] {
  const thresholds = staleRoundThresholds(contextWindow)
  const recentToKeep = thresholds.recentToKeep
  const previewChars = previewCharsOverride ?? thresholds.previewChars

  if (messages.length <= CACHE_ANCHOR_MESSAGES + recentToKeep) return messages

  const recentStart = Math.max(CACHE_ANCHOR_MESSAGES, messages.length - recentToKeep)
  let changed = false

  const result = messages.map((msg, idx) => {
    if (idx < CACHE_ANCHOR_MESSAGES || idx >= recentStart) return msg
    if (msg.role !== 'tool') return msg
    if (msg.content.length <= previewChars) return msg

    changed = true
    const artifactMatch = msg.content.match(ARTIFACT_MARKER_REGEX)

    if (artifactMatch) {
      // Preserve the artifact marker at the tail so the model can recover the
      // full content via read_section. Trim preview to leave room for marker.
      const marker = artifactMatch[0]
      const removed = msg.content.length - previewChars
      const preview = msg.content.slice(0, previewChars)
      return {
        ...msg,
        content: `${preview}\n<stale-compacted removed_chars="${removed}" use_read_section_to_retrieve_full_content />\n${marker}`,
      }
    }

    const preview = msg.content.slice(0, previewChars)
    return { ...msg, content: `${preview}\n<stale-compacted removed_chars="${msg.content.length - previewChars}" />` }
  })

  return changed ? result : messages
}

