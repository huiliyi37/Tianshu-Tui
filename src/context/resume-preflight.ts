import type { Message } from '../api/types.js'
import type { OaiMessage, OaiToolMessage, OaiAssistantMessage } from '../api/oai-types.js'
import { groupIntoRounds, computeInvariantStatus, groupIntoRoundsOai } from './rounds.js'
import type { ResumePreflightReport } from './types.js'

export function runResumePreflight(messages: Message[]): ResumePreflightReport {
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

    const syntheticResults = orphanIds.map(id => ({
      type: 'tool_result' as const,
      tool_use_id: id,
      content: '[recovered] Tool result missing after interrupted session resume.',
      is_error: true,
    }))

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

/**
 * OAI-format resume preflight: detect and repair orphan tool_calls.
 * Inserts synthetic role='tool' messages for orphan tool_calls.
 */
export function runResumePreflightOai(messages: OaiMessage[]): OaiResumePreflightReport {
  const orphanCallIds = detectOrphanToolCallsOai(messages)
  const orphanResultIds = detectOrphanToolResultsOai(messages)

  if (orphanCallIds.length === 0) {
    return {
      messageCount: messages.length,
      roundCount: groupIntoRoundsOai(messages).length,
      repaired: false,
      syntheticResultsInserted: 0,
      safe: orphanResultIds.length === 0,
      messages,
    }
  }

  const repaired = [...messages]
  let inserted = 0

  // For each orphan tool_call, insert a synthetic tool result right after the assistant message
  for (let i = repaired.length - 1; i >= 0; i--) {
    const msg = repaired[i]!
    if (msg.role !== 'assistant' || !('tool_calls' in msg) || !msg.tool_calls) continue

    const orphans = msg.tool_calls.filter(tc => orphanCallIds.includes(tc.id))
    if (orphans.length === 0) continue

    const syntheticResults: OaiToolMessage[] = orphans.map(tc => ({
      role: 'tool' as const,
      tool_call_id: tc.id,
      content: '[recovered] Tool result missing after interrupted session resume.',
    }))

    // Insert right after the assistant message
    repaired.splice(i + 1, 0, ...syntheticResults)
    inserted += syntheticResults.length
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
