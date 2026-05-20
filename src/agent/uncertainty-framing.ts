/**
 * Uncertainty Framing — 万物为一原则④
 *
 * "模糊是力量，不是缺陷" — 当 confidence < 0.4 + destructive 操作时，
 * 输出结构化模糊而非猜测。
 *
 * 触发条件：sensorium.confidence < 0.4 + risk >= high
 * 注入点：cognitive projection
 */

export interface UncertaintyInput {
  confidence: number
  riskLevel: 'none' | 'low' | 'medium' | 'high'
  toolName?: string
}

export interface UncertaintyFraming {
  shouldFrame: boolean
  hint: string | null
}

const CONFIDENCE_THRESHOLD = 0.4

export function buildUncertaintyFraming(input: UncertaintyInput): UncertaintyFraming {
  const shouldFrame = input.confidence < CONFIDENCE_THRESHOLD
    && (input.riskLevel === 'high' || input.riskLevel === 'medium')

  if (!shouldFrame) {
    return { shouldFrame: false, hint: null }
  }

  return {
    shouldFrame: true,
    hint: buildUncertaintyHint(input),
  }
}

function buildUncertaintyHint(input: UncertaintyInput): string {
  const toolContext = input.toolName ? ` (工具: ${input.toolName})` : ''
  return [
    `[Uncertainty Framing] Confidence ${input.confidence.toFixed(2)} < 0.4 + risk=${input.riskLevel}${toolContext}`,
    '你不确定。不要猜。',
    '明确告诉用户你不确定，列出可能的选项，让用户决定。',
    '如果你有 60% 以上的把握，说明你的判断和依据。',
    '如果你低于 40% 的把握，坦诚说"我不确定"，不要伪装自信。',
  ].join('\n')
}
