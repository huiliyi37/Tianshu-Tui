export const BASE_BUDGET_TOKENS = 50_000
export const PRESSURE_BUDGET_TOKENS = 25_000
const CRITICAL_RSS_RATIO = 0.85

export interface TurnBudget {
  readonly maxTokensPerTurn: number
  readonly usedTokens: number
  isExhausted(): boolean
  consume(tokens: number): void
  reset(): void
}

export function createTurnBudget(rssRatio: number): TurnBudget {
  const maxTokensPerTurn = rssRatio >= CRITICAL_RSS_RATIO
    ? 0
    : rssRatio >= 0.7
      ? PRESSURE_BUDGET_TOKENS
      : BASE_BUDGET_TOKENS
  let used = 0
  return {
    maxTokensPerTurn,
    get usedTokens() { return used },
    isExhausted() { return used >= maxTokensPerTurn },
    consume(tokens: number) { used += tokens },
    reset() { used = 0 },
  }
}
