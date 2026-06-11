/**
 * UserCorrectionDetector — rule-based detection of user corrections in messages.
 *
 * Detects patterns like "不是A，是B" / "actually it's B not A" / "日志错了"
 * and produces UserCorrection records that feed into the Assertion Ledger
 * (ContextClaimStore with kind='user_correction', confidence=1.0).
 *
 * No LLM call — pure regex + heuristic matching.
 */

export interface UserCorrection {
  subject: string
  wrongValue: string | undefined
  rightValue: string
  confidence: number
  sourceMessage: string
  turn: number
}

interface CorrectionPattern {
  regex: RegExp
  extract: (match: RegExpMatchArray, fullText: string) => Partial<UserCorrection> | null
}

const ZH_NOT_A_IS_B: CorrectionPattern = {
  regex: /不是\s*[「「"']?(.+?)[」」"']?\s*[，,]\s*(?:而)?是\s*[「「"']?(.+?)[」」"']?\s*(?:[。，,.!]|$)/,
  extract: (m) => ({
    wrongValue: m[1]?.trim(),
    rightValue: m[2]?.trim() ?? '',
  }),
}

const ZH_ACTUALLY_IS_B: CorrectionPattern = {
  regex: /(?:其实|实际上?|事实上)\s*(?:应该)?是\s*[「「"']?(.+?)[」」"']?\s*(?:不是\s*[「「"']?(.+?)[」」"']?)?\s*(?:[。，,.!]|$)/,
  extract: (m) => ({
    rightValue: m[1]?.trim() ?? '',
    wrongValue: m[2]?.trim(),
  }),
}

const ZH_X_IS_WRONG: CorrectionPattern = {
  regex: /(.{1,30}?)(?:是错的|不对|有误|写错了|搞错了|弄错了)/,
  extract: (m) => ({
    subject: m[1]?.trim() ?? '',
    wrongValue: undefined,
    rightValue: '',
  }),
}

const ZH_LOG_WRONG: CorrectionPattern = {
  regex: /(?:日志|log|输出|结果|显示|报告|报错)(?:里|中|上)?(?:的)?(?:是)?(?:错的|不对|有误|写错了|搞错了)/i,
  extract: () => ({
    subject: '工具/日志结果',
    wrongValue: undefined,
    rightValue: '',
  }),
}

const ZH_I_MEAN: CorrectionPattern = {
  regex: /(?:我说的是|我的意思是|我指的是)\s*[「「"']?(.+?)[」」"']?\s*(?:[。，,.!]|$)/,
  extract: (m) => ({
    rightValue: m[1]?.trim() ?? '',
  }),
}

const EN_NO_ITS_B: CorrectionPattern = {
  regex: /(?:no,?\s+)?(?:it(?:'s|\s+is)\s+(?:actually\s+)?|actually\s+(?:it(?:'s|\s+is)\s+)?)[「"']?(.+?)[「"']?\s*(?:not\s+[「"']?(.+?)[「"']?)?\s*(?:[.,!]|$)/i,
  extract: (m) => ({
    rightValue: m[1]?.trim() ?? '',
    wrongValue: m[2]?.trim(),
  }),
}

const EN_NOT_A_BUT_B: CorrectionPattern = {
  regex: /(?:it(?:'s|\s+is)\s+)?not\s+[「"']?(.+?)[「"']?\s*[,]\s*(?:it(?:'s|\s+is)\s+|but\s+)?[「"']?(.+?)[「"']?\s*(?:[.,!]|$)/i,
  extract: (m) => ({
    wrongValue: m[1]?.trim(),
    rightValue: m[2]?.trim() ?? '',
  }),
}

const EN_WRONG_INCORRECT: CorrectionPattern = {
  regex: /(?:that(?:'s|\s+is)\s+)?(?:wrong|incorrect|inaccurate|a\s+mistake)/i,
  extract: () => ({
    subject: 'previous statement',
    wrongValue: undefined,
    rightValue: '',
  }),
}

const EN_I_SAID: CorrectionPattern = {
  regex: /(?:I\s+said|I\s+meant|I\s+mean|what\s+I\s+(?:said|meant)\s+(?:is|was))\s+[「"']?(.+?)[「"']?\s*(?:[.,!]|$)/i,
  extract: (m) => ({
    rightValue: m[1]?.trim() ?? '',
  }),
}

const CORRECTION_PATTERNS: CorrectionPattern[] = [
  ZH_NOT_A_IS_B,
  ZH_ACTUALLY_IS_B,
  ZH_X_IS_WRONG,
  ZH_LOG_WRONG,
  ZH_I_MEAN,
  EN_NO_ITS_B,
  EN_NOT_A_BUT_B,
  EN_WRONG_INCORRECT,
  EN_I_SAID,
]

/**
 * Quick check — is the user message likely a correction?
 * Used as a fast gate before running full pattern matching.
 */
const CORRECTION_SIGNAL_RE = /不是.{0,15}是|其实是|实际上?是|事实上是|是错的|不对|有误|写错了|搞错了|弄错了|日志.{0,5}(?:错|不对|有误)|我说的是|我的意思是|我指的是|actually|not\s+\w+\s*,?\s*(?:but|it'?s)|wrong|incorrect|inaccurate|I\s+(?:said|meant|mean)|that'?s\s+(?:wrong|incorrect)|no,?\s+it'?s/i

export function hasUserCorrectionSignal(text: string): boolean {
  return CORRECTION_SIGNAL_RE.test(text)
}

export function detectUserCorrections(text: string, turn: number): UserCorrection[] {
  if (!hasUserCorrectionSignal(text)) return []

  const corrections: UserCorrection[] = []
  const seen = new Set<string>()

  for (const pattern of CORRECTION_PATTERNS) {
    const match = text.match(pattern.regex)
    if (!match) continue

    const extracted = pattern.extract(match, text)
    if (!extracted) continue

    const rightValue = extracted.rightValue ?? ''
    const key = `${extracted.wrongValue ?? ''}→${rightValue}`
    if (seen.has(key)) continue
    seen.add(key)

    corrections.push({
      subject: extracted.subject ?? '',
      wrongValue: extracted.wrongValue,
      rightValue,
      confidence: 1.0,
      sourceMessage: text.slice(0, 500),
      turn,
    })
  }

  return corrections
}

/**
 * Build a human-readable claim text from a UserCorrection.
 * This is stored in the ContextClaim.text field.
 */
export function correctionToClaimText(correction: UserCorrection): string {
  if (correction.wrongValue && correction.rightValue) {
    return `用户纠正: "${correction.wrongValue}" 是错误的，正确值是 "${correction.rightValue}"`
  }
  if (correction.rightValue) {
    return `用户纠正: 正确值是 "${correction.rightValue}"`
  }
  if (correction.subject) {
    return `用户纠正: ${correction.subject}的内容有误（详见原文: "${correction.sourceMessage.slice(0, 100)}"）`
  }
  return `用户纠正: ${correction.sourceMessage.slice(0, 150)}`
}
