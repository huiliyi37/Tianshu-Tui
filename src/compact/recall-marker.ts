/**
 * Recall markers for compacted-history artifacts.
 *
 * When the model uses `read_section` to recall a slice of a `compact-history`
 * artifact (the cold-storage verbatim block produced by storage-layer
 * compaction), the returned tool result is prefixed with a recall marker.
 *
 * Two consumers depend on the marker:
 *  1. read_section (producer): tags recalled compact-history content.
 *  2. compact-archive serialization (consumer): on the NEXT compaction,
 *     a recalled block is collapsed back to a one-line pointer instead of
 *     being re-archived verbatim — the original artifact still holds the
 *     content, so recall stays possible without the recalled bytes
 *     accumulating in storage and cancelling out the compression. (See the
 *     recall-eviction todo in the layered-archival plan.)
 */

/** Tool name under which compacted history blocks are saved in ArtifactStore. */
export const COMPACT_HISTORY_TOOL = 'compact-history'

/** True when an artifact id belongs to a compacted-history block. */
export function isCompactHistoryId(id: string): boolean {
  return id.startsWith(`${COMPACT_HISTORY_TOOL}:`)
}

// ASCII-only marker: avoids Unicode (↺) cross-platform / storage edge cases
// and false matches when model output happens to contain the glyph.
const RECALL_MARKER_RE = /^\[recalled (compact-history:[^\s\]]+) (L\d+-L\d+|c\d+-c\d+)\]/

/** Build the single-line marker prepended to recalled compact-history content. */
export function buildRecallMarker(artifactId: string, section: string): string {
  return `[recalled ${artifactId} ${section}]`
}

/**
 * Parse a recall marker from the start of a message's content.
 * Returns the source artifact id + section, or null when the content is not a
 * recalled compact-history block.
 */
export function parseRecallMarker(content: string): { artifactId: string; section: string } | null {
  const m = content.match(RECALL_MARKER_RE)
  if (!m) return null
  return { artifactId: m[1]!, section: m[2]! }
}
