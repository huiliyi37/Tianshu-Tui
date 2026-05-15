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
      messages,
    }
  }

  const repaired = [...messages]
  let inserted = 0
  const orphanToolUseIds = new Set<string>()

  for (const round of rounds) {
    if (round.apiInvariant === 'broken' && round.hasToolUse) {
      const asstMsg = messages[round.startMessageIndex]
      if (asstMsg && asstMsg.role === 'assistant' && typeof asstMsg.content !== 'string') {
        for (const block of asstMsg.content) {
          if (block.type === 'tool_use') {
            orphanToolUseIds.add(block.id)
          }
        }
      }
    }
  }

  if (orphanToolUseIds.size > 0) {
    const syntheticResults = [...orphanToolUseIds].map(id => ({
      type: 'tool_result' as const,
      tool_use_id: id,
      content: 'Tool result unavailable: recovered from interrupted tool execution.',
      is_error: true,
    }))

    repaired.push({ role: 'user', content: syntheticResults })
    inserted = syntheticResults.length
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
    messages: repaired,
  }
}
