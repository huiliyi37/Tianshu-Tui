import type { CompactCircuitBreakerState, CompactDecision, CompactTier } from './types.js'

export interface CompactPolicyInput {
  estimatedTokens: number
  maxTokens: number
  turn: number
  failures: CompactCircuitBreakerState
}

function tierForRatio(ratio: number): CompactTier {
  if (ratio >= 0.95) return 4
  if (ratio >= 0.88) return 3
  if (ratio >= 0.78) return 2
  if (ratio >= 0.6) return 1
  return 0
}

function reasonForTier(tier: CompactTier): string {
  if (tier === 0) return 'context usage below watch threshold'
  if (tier === 1) return 'tool results exceeded watch threshold'
  if (tier === 2) return 'session memory compact recommended'
  if (tier === 3) return 'reactive round summarization required'
  return 'emergency truncation required'
}

export function decideCompactTier(input: CompactPolicyInput): CompactDecision {
  if (input.failures.disabledUntilTurn !== undefined && input.turn < input.failures.disabledUntilTurn) {
    return { tier: 0, reason: 'automatic compact circuit breaker is open', shouldCompact: false }
  }
  const ratio = input.maxTokens > 0 ? input.estimatedTokens / input.maxTokens : 1
  const tier = tierForRatio(ratio)
  return { tier, reason: reasonForTier(tier), shouldCompact: tier > 0 }
}

export function recordCompactFailure(state: CompactCircuitBreakerState, turn: number): CompactCircuitBreakerState {
  const consecutiveFailures = state.consecutiveFailures + 1
  return {
    consecutiveFailures,
    disabledUntilTurn: consecutiveFailures >= 3 ? turn + 3 : state.disabledUntilTurn,
  }
}

export function recordCompactSuccess(_state: CompactCircuitBreakerState): CompactCircuitBreakerState {
  return { consecutiveFailures: 0 }
}
