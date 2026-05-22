import type { OaiMessage } from '../api/oai-types.js'
import { groupIntoRoundsOai, computeOaiInvariantStatus } from './rounds.js'
import type { CompactionState, ContextAnchor, ContextLedger, LedgerSessionMemoryState } from './types.js'

export function createContextLedger(
  sessionId: string,
  transcriptPath: string,
  messages: OaiMessage[],
  contextWindow: number,
  sessionMemory?: LedgerSessionMemoryState,
  extraAnchors?: ContextAnchor[],
): ContextLedger {
  const rounds = groupIntoRoundsOai(messages)
  const estimatedTokens = rounds.reduce((sum, r) => sum + r.tokenEstimate, 0)
  const invariantStatus = computeOaiInvariantStatus(rounds)

  let compactionState: CompactionState = 'healthy'
  if (estimatedTokens > contextWindow * 0.95) compactionState = 'critical'
  else if (estimatedTokens > contextWindow * 0.8) compactionState = 'compacting'
  else if (estimatedTokens > contextWindow * 0.5) compactionState = 'warning'

  return {
    sessionId, transcriptPath, rounds,
    anchors: extraAnchors ?? [], workingSet: [], compactedSpans: [], sessionMemory: sessionMemory ?? null,
    tokenBudget: { estimatedTokens, maxTokens: contextWindow, warningThreshold: Math.floor(contextWindow * 0.5), compactionState },
    apiInvariantStatus: invariantStatus,
  }
}
