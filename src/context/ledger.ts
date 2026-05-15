import type { Message } from '../api/types.js'
import { groupIntoRounds, computeInvariantStatus } from './rounds.js'
import type { CompactionState, ContextLedger, LedgerSessionMemoryState } from './types.js'

export function createContextLedger(
  sessionId: string,
  transcriptPath: string,
  messages: Message[],
  contextWindow: number,
  sessionMemory?: LedgerSessionMemoryState,
): ContextLedger {
  const rounds = groupIntoRounds(messages)
  const estimatedTokens = rounds.reduce((sum, r) => sum + r.tokenEstimate, 0)
  const invariantStatus = computeInvariantStatus(rounds)

  let compactionState: CompactionState = 'healthy'
  if (estimatedTokens > contextWindow * 0.95) compactionState = 'critical'
  else if (estimatedTokens > contextWindow * 0.8) compactionState = 'compacting'
  else if (estimatedTokens > contextWindow * 0.5) compactionState = 'warning'

  return {
    sessionId, transcriptPath, rounds,
    anchors: [], workingSet: [], compactedSpans: [], sessionMemory: sessionMemory ?? null,
    tokenBudget: { estimatedTokens, maxTokens: contextWindow, warningThreshold: Math.floor(contextWindow * 0.5), compactionState },
    apiInvariantStatus: invariantStatus,
  }
}
