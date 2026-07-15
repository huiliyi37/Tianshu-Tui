import type { OaiMessage } from '../api/oai-types.js'
import { CACHE_ANCHOR_MESSAGES, staleRoundThresholds } from './constants.js'
// Marker-last contract and regex live in recovery-ref.ts (single source of
// truth, shared with the budget-layer transforms in per-message-budget.ts).
import { ARTIFACT_MARKER_REGEX } from './recovery-ref.js'

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
  /**
   * W1-A3: `message index → artifactId` map produced by the boundary archive
   * adapter (see boundary-archive.ts). Pure data — this transform never
   * touches ArtifactStore. When the map is provided, a marker-less message is
   * only truncated if its original was archived (map has an entry); otherwise
   * it is kept intact (fail-open). When the map is absent (legacy callers),
   * behavior is unchanged.
   */
  recoveryRefs?: ReadonlyMap<number, string>,
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

    const artifactMatch = msg.content.match(ARTIFACT_MARKER_REGEX)

    if (artifactMatch) {
      // Preserve the artifact marker at the tail so the model can recover the
      // full content via read_section. Trim preview to leave room for marker.
      changed = true
      const marker = artifactMatch[0]
      const removed = msg.content.length - previewChars
      const preview = msg.content.slice(0, previewChars)
      return {
        ...msg,
        content: `${preview}\n<stale-compacted removed_chars="${removed}" use_read_section_to_retrieve_full_content />\n${marker}`,
      }
    }

    if (recoveryRefs) {
      const refId = recoveryRefs.get(idx)
      if (!refId) return msg // archive failed or skipped — keep original (fail-open)
      changed = true
      const removed = msg.content.length - previewChars
      const preview = msg.content.slice(0, previewChars)
      return {
        ...msg,
        content: `${preview}\n<stale-compacted removed_chars="${removed}" use_read_section_to_retrieve_full_content />\n[artifact:${refId}]`,
      }
    }

    changed = true
    const preview = msg.content.slice(0, previewChars)
    return { ...msg, content: `${preview}\n<stale-compacted removed_chars="${msg.content.length - previewChars}" />` }
  })

  return changed ? result : messages
}

