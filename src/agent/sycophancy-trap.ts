/**
 * Sycophancy Trap — CVM 特权指令 Trap
 *
 * 检测模式：连续 N 轮"盲从执行"——有破坏性操作但没有质疑、也没有验证——
 * 且 sensorium.confidence 持续下降。
 *
 * 不能为了质疑而质疑。以下情况不属于 sycophancy：
 * - 执行前有验证（read_file、grep、typecheck 等）
 * - 任务简单明确、不需要质疑（单一文件重命名等）→ 由调用方根据风险判断
 * - confidence 稳定或上升 → 模型对自己的判断有信心
 *
 * 触发条件：连续 3+ 轮 agree + confidence 单调递减
 * 注入点：immune signal → cognitive projection
 */

export interface TurnAgreement {
  /** Model executed blindly: destructive actions without question or verification */
  agreedWithUser: boolean
  /** Current sensorium confidence */
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

    // Check for consecutive blind agreement
    const recent = history.slice(-CONSECUTIVE_THRESHOLD)
    const allAgreed = recent.every(t => t.agreedWithUser)
    if (!allAgreed) return false

    // Check for monotonically decreasing confidence
    // (stable/rising confidence means the model believes in its actions)
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
    '[Sycophancy Trap] 连续盲从执行 + confidence 下降 — 你可能在讨好用户。',
    '质疑假设：用户的要求是否正确？有没有更好的替代方案？',
    '如果不确定，明确说明不确定性，而不是盲目执行。',
    '建议：先阅读/验证相关文件（read_file, grep），确认变更的必要性和正确性后再执行。',
  ].join('\n')
}
