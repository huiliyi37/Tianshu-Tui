import type { Message, ContentBlock } from '../api/types.js'
import type { OaiMessage, OaiToolMessage, OaiAssistantMessage } from '../api/oai-types.js'
import { groupIntoRounds, computeInvariantStatus, groupIntoRoundsOai } from './rounds.js'
import type { ResumePreflightReport } from './types.js'
import {
  extractTargetPath,
  formatWriteRecoveryContent,
  type WriteProbe,
} from './write-evidence-probe.js'

// ─── orphan diagnostic: RIVET_DEBUG_ORPHAN=1 dumps adjacency-violation details ───
const DEBUG_ORPHAN = process.env.RIVET_DEBUG_ORPHAN === '1'

function syntheticResultContent(
  toolName?: string,
  filePath?: string,
  writeProbe?: WriteProbe,
  args?: unknown,
): string {
  const evidence = toolName && writeProbe && args !== undefined
    ? writeProbe(toolName, args)
    : undefined
  return formatWriteRecoveryContent(toolName, filePath, evidence)
}

export interface OaiResumePreflightOptions {
  /** Optional cwd-scoped disk probe for write-tool orphan synthesis (default on). */
  writeProbe?: WriteProbe
}

export function runResumePreflight(
  messages: Message[],
  options?: OaiResumePreflightOptions,
): ResumePreflightReport {
  const rounds = groupIntoRounds(messages)
  const invariant = computeInvariantStatus(rounds)

  if (!invariant.orphanToolUse.length) {
    return {
      messageCount: messages.length,
      roundCount: rounds.length,
      invariant,
      repaired: false,
      syntheticResultsInserted: 0,
      orphanToolResultIds: invariant.orphanToolResult,
      safe: !invariant.orphanToolResult.length,
      messages,
    }
  }

  const repaired = [...messages]
  let inserted = 0

  // Walk rounds in reverse so insertion indices stay stable.
  // Rounds from groupIntoRounds are non-overlapping with strictly increasing
  // startMessageIndex, so reverse iteration guarantees each splice shifts
  // only lower-indexed positions that we've already processed.
  const brokenRounds = [...rounds]
    .filter(r => r.apiInvariant === 'broken' && r.hasToolUse)
    .reverse()

  for (const round of brokenRounds) {
    const asstMsg = repaired[round.startMessageIndex]
    if (!asstMsg || asstMsg.role !== 'assistant' || typeof asstMsg.content === 'string') continue

    const orphanIds: string[] = []
    for (const block of asstMsg.content) {
      if (block.type === 'tool_use') orphanIds.push(block.id)
    }
    if (orphanIds.length === 0) continue

    const syntheticResults = orphanIds.map(id => {
      const blocks = asstMsg.content as ContentBlock[]
      const toolUse = blocks.find(b => b.type === 'tool_use' && b.id === id)
      const toolName = toolUse?.type === 'tool_use' ? toolUse.name : undefined
      const filePath = toolUse?.type === 'tool_use' ? extractTargetPath(toolUse.input) : undefined
      const args = toolUse?.type === 'tool_use' ? toolUse.input : undefined
      return {
        type: 'tool_result' as const,
        tool_use_id: id,
        content: syntheticResultContent(toolName, filePath, options?.writeProbe, args),
        is_error: false,
      }
    })

    // Insert right after the assistant message with orphan tool_use
    repaired.splice(round.startMessageIndex + 1, 0, { role: 'user', content: syntheticResults })
    inserted += syntheticResults.length
  }

  const newRounds = groupIntoRounds(repaired)
  const newInvariant = computeInvariantStatus(newRounds)

  return {
    messageCount: messages.length,
    roundCount: rounds.length,
    invariant: newInvariant,
    repaired: true,
    syntheticResultsInserted: inserted,
    orphanToolResultIds: newInvariant.orphanToolResult,
    safe: !newInvariant.orphanToolUse.length && !newInvariant.orphanToolResult.length,
    messages: repaired,
  }
}

// ─── OAI-format resume preflight ───

export interface OaiResumePreflightReport {
  messageCount: number
  roundCount: number
  repaired: boolean
  syntheticResultsInserted: number
  safe: boolean
  messages: OaiMessage[]
}

/**
 * Detect orphan tool_calls in OAI format.
 * Returns IDs of tool_calls that have no matching role='tool' response.
 */
export function detectOrphanToolCallsOai(messages: OaiMessage[]): string[] {
  const orphanIds: string[] = []
  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i]!
    if (msg.role === 'assistant' && 'tool_calls' in msg && msg.tool_calls) {
      for (const tc of msg.tool_calls) {
        const hasResult = messages.slice(i + 1).some(
          m => m.role === 'tool' && 'tool_call_id' in m && m.tool_call_id === tc.id,
        )
        if (!hasResult) orphanIds.push(tc.id)
      }
    }
  }
  return orphanIds
}

/**
 * Detect orphan tool messages in OAI format.
 * Returns tool_call_ids that have no matching assistant tool_call.
 */
export function detectOrphanToolResultsOai(messages: OaiMessage[]): string[] {
  const allToolCallIds = new Set<string>()
  for (const msg of messages) {
    if (msg.role === 'assistant' && 'tool_calls' in msg && msg.tool_calls) {
      for (const tc of msg.tool_calls) {
        allToolCallIds.add(tc.id)
      }
    }
  }

  const orphanResultIds: string[] = []
  for (const msg of messages) {
    if (msg.role === 'tool' && 'tool_call_id' in msg) {
      if (!allToolCallIds.has(msg.tool_call_id)) {
        orphanResultIds.push(msg.tool_call_id)
      }
    }
  }
  return orphanResultIds
}

const SYNTHETIC_TOOL_RESULT_CONTENT = syntheticResultContent()

/**
 * True when every assistant `tool_calls` message is IMMEDIATELY followed by a
 * contiguous run of `tool` messages that covers exactly its tool_call ids (one
 * each, no foreign ids), and no `tool` message appears outside such a run.
 *
 * This is the provider's real requirement. The id-presence check
 * (detectOrphanToolCallsOai) is necessary but NOT sufficient: a tool result that
 * exists but sits AFTER an intervening user/assistant message (e.g. a tool batch
 * aborted mid-flight whose late addToolResults landed past the next turn) has a
 * matching id yet still triggers "insufficient tool messages following
 * tool_calls". Adjacency is what must hold.
 */
function isToolAdjacencyCleanOai(messages: OaiMessage[]): boolean {
  for (let i = 0; i < messages.length; i++) {
    const m = messages[i]!
    if (m.role === 'tool') {
      if (DEBUG_ORPHAN) {
        const tid = (m as OaiToolMessage).tool_call_id
        // eslint-disable-next-line no-console
        console.error(`[RIVET_DEBUG_ORPHAN] adjacency fail: stray tool at L${i} id=${tid} — no preceding assistant(tool_calls)`)
      }
      return false
    }
    if (m.role !== 'assistant' || !('tool_calls' in m) || !m.tool_calls || m.tool_calls.length === 0) continue

    const ids = m.tool_calls.map(tc => tc.id)
    const seen = new Set<string>()
    let j = i + 1
    while (j < messages.length && messages[j]!.role === 'tool') {
      const id = (messages[j] as OaiToolMessage).tool_call_id
      if (!ids.includes(id) || seen.has(id)) {
        if (DEBUG_ORPHAN) {
          const reason = !ids.includes(id) ? `foreign id=${id} not in [${ids.join(',')}]` : `duplicate id=${id}`
          // eslint-disable-next-line no-console
          console.error(`[RIVET_DEBUG_ORPHAN] adjacency fail: assistant(tool_calls) at L${i} → tool at L${j} ${reason}`)
        }
        return false
      }
      seen.add(id)
      j++
    }
    if (seen.size !== ids.length) {
      if (DEBUG_ORPHAN) {
        const missing = ids.filter(id => !seen.has(id))
        // eslint-disable-next-line no-console
        console.error(`[RIVET_DEBUG_ORPHAN] adjacency fail: assistant(tool_calls) at L${i} missing tool results for [${missing.join(',')}] (found ${seen.size}/${ids.length})`)
      }
      return false
    }
    i = j - 1
  }
  return true
}

/**
 * OAI-format resume preflight: guarantee the tool-call adjacency invariant.
 *
 * Rebuilds each assistant `tool_calls` message's tool-result run in tool_call
 * order, pulling the matching `tool` message from anywhere in the history (so a
 * late/out-of-order result is MOVED back into position) and synthesizing a
 * placeholder only when no result exists at all. Any leftover `tool` message
 * (a duplicate or truly orphaned result) is dropped. No-op — same array
 * reference, prefix cache untouched — when adjacency already holds.
 */
export function runResumePreflightOai(
  messages: OaiMessage[],
  options?: OaiResumePreflightOptions,
): OaiResumePreflightReport {
  if (isToolAdjacencyCleanOai(messages)) {
    return {
      messageCount: messages.length,
      roundCount: groupIntoRoundsOai(messages).length,
      repaired: false,
      syntheticResultsInserted: 0,
      safe: true,
      messages,
    }
  }

  // Index every tool message by id as a FIFO queue so identical-id results
  // (rare, pollution) are consumed deterministically front-to-back.
  const toolMsgsById = new Map<string, OaiToolMessage[]>()
  for (const m of messages) {
    if (m.role === 'tool') {
      const q = toolMsgsById.get(m.tool_call_id) ?? []
      q.push(m)
      toolMsgsById.set(m.tool_call_id, q)
    }
  }

  const repaired: OaiMessage[] = []
  let inserted = 0

  for (const m of messages) {
    if (m.role === 'tool') continue // re-emitted in-position below; leftovers are dropped
    repaired.push(m)
    if (m.role !== 'assistant' || !('tool_calls' in m) || !m.tool_calls || m.tool_calls.length === 0) continue

    for (const tc of m.tool_calls) {
      const q = toolMsgsById.get(tc.id)
      const existing = q?.shift()
      if (existing) {
        repaired.push({ role: 'tool', tool_call_id: tc.id, content: existing.content })
      } else {
        const toolName = tc.function?.name
        const filePath = extractTargetPath(tc.function?.arguments)
        const args = tc.function?.arguments
        repaired.push({
          role: 'tool',
          tool_call_id: tc.id,
          content: syntheticResultContent(toolName, filePath, options?.writeProbe, args),
        })
        inserted++
        if (DEBUG_ORPHAN) {
          // eslint-disable-next-line no-console
          console.error(`[RIVET_DEBUG_ORPHAN] synthetic result for tool_call id=${tc.id} name=${toolName ?? '?'} — NO matching tool result found anywhere in ${messages.length} messages`)
        }
      }
    }
  }

  return {
    messageCount: messages.length,
    roundCount: groupIntoRoundsOai(repaired).length,
    repaired: true,
    syntheticResultsInserted: inserted,
    safe: true,
    messages: repaired,
  }
}
