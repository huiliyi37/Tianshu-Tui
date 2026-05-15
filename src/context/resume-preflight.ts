import type { Message } from '../api/types.js'
import { groupIntoRounds, computeInvariantStatus } from './rounds.js'
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

  // Walk rounds in reverse so insertion indices stay stable
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
      content: 'Tool result unavailable: recovered from interrupted tool execution.',
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
