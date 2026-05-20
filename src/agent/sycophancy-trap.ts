/**
 * Sycophancy Trap — CVM 特权指令 Trap
 *
 * 当 agent 连续 N 次"同意用户"且 sensorium.confidence 下降时，
 * 在 prompt 中注入质疑提示。
 *
 * 触发条件：连续 3+ 轮 agree + confidence 单调递减
 * 注入点：cognitive projection
 */

export interface TurnAgreement {
  agreedWithUser: boolean
  confidence: number
}

export interface SycophancyTrap {
  recordTurn(turn: TurnAgreement): void
  shouldInjectChallenge(): boolean
  getHint(): string | null
  reset(): void
}

const WINDOW_SIZE = 5
const CONSECUTIVE_THRESHOLD = 3

export function createSycophancyTrap(): SycophancyTrap {
  const history: TurnAgreement[] = []

  function recordTurn(turn: TurnAgreement): void {
    history.push(turn)
    if (history.length > WINDOW_SIZE) {
      history.shift()
    }
  }

  function shouldInjectChallenge(): boolean {
    if (history.length < CONSECUTIVE_THRESHOLD) return false

    // Check for consecutive agreement
    const recent = history.slice(-CONSECUTIVE_THRESHOLD)
    const allAgreed = recent.every(t => t.agreedWithUser)
    if (!allAgreed) return false

    // Check for monotonically decreasing confidence
    const confidences = recent.map(t => t.confidence)
    const monotonicallyDecreasing = confidences.every((c, i) =>
      i === 0 || c < confidences[i - 1]!
    )

    return monotonicallyDecreasing
  }

  function getHint(): string | null {
    if (!shouldInjectChallenge()) return null
    return buildChallengeHint()
  }

  function reset(): void {
    history.length = 0
  }

  return { recordTurn, shouldInjectChallenge, getHint, reset }
}

export function buildChallengeHint(): string {
  return [
    '[Sycophancy Trap] 连续同意 + confidence 下降 — 你可能在讨好用户。',
    '质疑假设：用户的要求是否正确？有没有更好的替代方案？',
    '如果不确定，明确说明不确定性，而不是盲目执行。',
  ].join('\n')
}
