/**
 * Sycophancy Trap — 认知自尊保护
 *
 * 检测模式：连续 N 轮无验证推进 + confidence 持续下降。
 * 信号含义：agent 可能在未充分理解的情况下顺从推进，
 * 需要一个温和提醒来恢复"先读再改"的节奏。
 *
 * 设计原则（来自 Askell 美德伦理）：
 * - 不指控"你在讨好"——指控会导致为了质疑而质疑
 * - 不指令"去质疑用户"——用户的指令可能完全正确
 * - 只提醒"你最近没有验证就推进了"——让 agent 自己判断是否需要回头确认
 *
 * 不触发的情况：
 * - 执行前有验证（read_file、grep、typecheck 等）
 * - confidence 稳定或上升 → agent 对自己的判断有信心
 *
 * 触发条件：连续 3+ 轮 agree + confidence 单调递减
 * 注入点：cognitive projection（温和提醒，不强制行为）
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
  return '你最近几轮没有验证就推进了改动，且你对当前方向的信心在下降。是否需要先读取相关文件确认？如果你的判断有依据，保持立场即可。'
}
