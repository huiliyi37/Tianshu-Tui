/**
 * Stable serialization of discarded message history for cold-storage archival.
 *
 * When storage-layer compaction (tryPartialCompact / replaceWithCheckpoint)
 * drops a zone of messages, the dropped zone is serialized here and saved as a
 * `compact-history` artifact so the model can later `read_section` any earlier
 * message verbatim instead of relying solely on the lossy LLM summary.
 *
 * ## Serialization contract (must stay stable — read_section locates by line)
 *
 * Every message is rendered with a fixed divider header:
 *
 *   --- turn:N role:ROLE ---
 *   <body line 1>
 *   <body line 2>
 *
 * Sections are cut **per message** (message → line range), NOT per turn: a
 * single assistant message can carry content + reasoning + several tool_calls
 * spanning dozens of lines, and a single tool result can be tens of thousands
 * of chars, so a turn→line mapping would be too coarse to locate precisely.
 * The per-message divider guarantees byte-stable boundaries; the embedded
 * catalog aggregates those into a compact turn→line directory for the model.
 */

import type { OaiMessage } from '../api/oai-types.js'
import { oaiMessageText } from '../api/oai-types.js'
import type { ArtifactSection } from '../artifact/types.js'
import { parseRecallMarker } from '../compact/recall-marker.js'

export interface SerializedArchive {
  rawContent: string
  sections: ArtifactSection[]
  /** Aggregated turn → line range, used to build the embedded recall catalog. */
  turnRanges: Array<{ turn: number; lineStart: number; lineEnd: number }>
}

function archiveHeader(turn: number, role: string): string {
  return `--- turn:${turn} role:${role} ---`
}

/** Render the body of a single message for verbatim archival. */
function renderBody(msg: OaiMessage): string {
  if (msg.role === 'user') {
    return oaiMessageText(msg)
  }
  if (msg.role === 'tool') {
    // Recall-eviction: a recalled compact-history block is collapsed back to a
    // one-line pointer rather than re-archived. The original artifact still
    // holds the bytes, so the pointer keeps it recallable without duplicating
    // content into the new artifact (which would cancel out the compression).
    const recall = parseRecallMarker(msg.content)
    if (recall) {
      return `[recalled → ${recall.artifactId} ${recall.section} (see original artifact)]`
    }
    return msg.content
  }
  if (msg.role === 'assistant') {
    const parts: string[] = []
    if (typeof msg.content === 'string' && msg.content.length > 0) parts.push(msg.content)
    if (msg.reasoning_content && msg.reasoning_content.length > 0) {
      parts.push(`[reasoning]\n${msg.reasoning_content}`)
    }
    if (msg.tool_calls && msg.tool_calls.length > 0) {
      for (const call of msg.tool_calls) {
        parts.push(`[tool_call ${call.function.name}] ${call.function.arguments}`)
      }
    }
    return parts.join('\n')
  }
  // system
  return typeof (msg as { content?: unknown }).content === 'string'
    ? (msg as { content: string }).content
    : ''
}

/**
 * Serialize a message zone into a byte-stable raw blob plus per-message
 * sections and an aggregated turn→line directory.
 */
export function serializeMessagesForArchive(messages: OaiMessage[]): SerializedArchive {
  const sections: ArtifactSection[] = []
  const turnAgg = new Map<number, { lineStart: number; lineEnd: number }>()
  const blocks: string[] = []

  let turn = 0
  let seenUser = false
  let line = 1

  messages.forEach((msg, idx) => {
    if (msg.role === 'user') {
      if (seenUser) turn++
      seenUser = true
    }

    const body = renderBody(msg)
    const block = body.length > 0
      ? `${archiveHeader(turn, msg.role)}\n${body}`
      : archiveHeader(turn, msg.role)

    const blockLines = block.split('\n').length
    const lineStart = line
    const lineEnd = line + blockLines - 1

    sections.push({
      name: `msg${idx} turn${turn} ${msg.role}`,
      lineStart,
      lineEnd,
      charCount: block.length,
    })

    const agg = turnAgg.get(turn)
    if (agg) {
      agg.lineEnd = lineEnd
    } else {
      turnAgg.set(turn, { lineStart, lineEnd })
    }

    blocks.push(block)
    // Blocks are joined with '\n', so the next block begins on the line right
    // after this one's last line (the join newline terminates this block).
    line = lineEnd + 1
  })

  const turnRanges = [...turnAgg.entries()]
    .map(([t, range]) => ({ turn: t, lineStart: range.lineStart, lineEnd: range.lineEnd }))
    .sort((a, b) => a.turn - b.turn)

  return { rawContent: blocks.join('\n'), sections, turnRanges }
}

const MAX_CATALOG_TURNS = 40

/** Build a compact turn→line directory for embedding into a summary message. */
export function buildArchiveCatalog(
  turnRanges: Array<{ turn: number; lineStart: number; lineEnd: number }>,
  artifactId: string,
): string {
  const shown = turnRanges.slice(0, MAX_CATALOG_TURNS)
  const lines = shown.map(t => `- turn ${t.turn}: L${t.lineStart}-L${t.lineEnd}`)
  if (turnRanges.length > MAX_CATALOG_TURNS) {
    const last = turnRanges[turnRanges.length - 1]!
    lines.push(`- … (+${turnRanges.length - MAX_CATALOG_TURNS} more turns, up to L${last.lineEnd})`)
  }
  return [
    `压缩历史目录 (artifact:${artifactId}, turn→行):`,
    ...lines,
  ].join('\n')
}

/**
 * Build the recall reference block appended to a compaction summary message.
 * Only ever placed inside a freshly-written summary message — never in the
 * frozen anchor prefix — so it is prefix-cache safe.
 */
export function buildRecallRefBlock(artifactId: string, count: number, catalog: string): string {
  return [
    '',
    '',
    '---',
    `[已归档 ${count} 条更早消息 → artifact:${artifactId}]`,
    catalog,
    `召回原文: read_section(artifactId="${artifactId}", section="L起-L止")`,
  ].join('\n')
}
