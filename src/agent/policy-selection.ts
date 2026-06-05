import type { EFEComponents } from './prediction-error.js'
import type { AffordanceScore } from './affordance.js'

// ─── Policy Selection — Active Inference Action Selection ─────────

export interface PolicyOption {
  toolName: string
  /** Expected Free Energy G(π) — 越低越好 */
  expectedFreeEnergy: number
  /** softmax 概率 [0, 1] */
  probability: number
}

export interface PolicySelectionOptions {
  /** softmax temperature. Default: 1 / precision */
  temperature?: number
  /** 返回的 top-K 结果数。Default: 5 */
  topK?: number
}

function clamp(value: number, min = 0, max = 1): number {
  return Math.max(min, Math.min(max, value))
}

/**
 * 计算每个候选动作的 Expected Free Energy G(π)。
 *
 * G(π_i) = -(epistemicValue × a_i.epistemic + pragmaticValue × a_i.instrumental)
 *
 * 越低越好：高 epistemic 工具在探索阶段得分高（负值更负），
 * 高 instrumental 工具在执行阶段得分高。
 */
function computeG(
  efe: EFEComponents,
  affordance: AffordanceScore,
): number {
  return -(
    efe.epistemicValue * affordance.epistemic +
    efe.pragmaticValue * affordance.instrumental
  )
}

/**
 * Softmax: p_i = exp(-G_i / T) / sum(exp(-G_j / T))
 *
 * G 值越低（越负）→ softmax 概率越高。
 * temperature T 控制随机性：高 T → 均匀分布（exploration），低 T → 峰值（exploitation）。
 */
function softmax(gValues: number[], temperature: number): number[] {
  const T = Math.max(temperature, 0.01) // 防止除零
  const negG = gValues.map(g => -g / T)
  const maxNegG = Math.max(...negG)
  const exps = negG.map(v => Math.exp(v - maxNegG)) // 数值稳定
  const sum = exps.reduce((a, b) => a + b, 0)
  if (sum === 0) return gValues.map(() => 1 / gValues.length)
  return exps.map(e => e / sum)
}

/**
 * 基于 EFE + Affordance 的 softmax 动作选择。
 *
 * 不替代 LLM 决策——结果作为 context 注入，LLM 保留自主选择权。
 *
 * @param efe EFE 计算结果
 * @param affordances 工具 affordance 评分（来自 affordance.ts）
 * @param options 可选配置（temperature、topK）
 * @returns 按概率降序排列的策略选项
 */
export function selectPolicy(
  efe: EFEComponents,
  affordances: Record<string, AffordanceScore>,
  options?: PolicySelectionOptions,
): PolicyOption[] {
  const topK = options?.topK ?? 5
  const temperature = options?.temperature ?? (1 / efe.precision)

  // 计算每个工具的 EFE
  const entries = Object.entries(affordances)
  const gValues = entries.map(([, a]) => computeG(efe, a))
  const probs = softmax(gValues, temperature)

  // 组装结果
  const results: PolicyOption[] = entries.map(([toolName], i) => ({
    toolName,
    expectedFreeEnergy: Math.round(gValues[i]! * 1_000_000) / 1_000_000,
    probability: Math.round(probs[i]! * 1_000_000) / 1_000_000,
  }))

  // 按概率降序 → Top-K
  results.sort((a, b) => b.probability - a.probability)
  return results.slice(0, topK)
}

// ─── Policy Guidance Rendering ────────────────────────────────────

function escapeXml(text: string): string {
  return text
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
}

/**
 * 渲染策略引导 XML 块，注入 context 供 LLM 参考。
 *
 * 不强制选择——LLM 始终保留工具选择的最终决定权。
 * 空状态时返回空字符串。
 */
export function renderPolicyGuidance(
  policies: PolicyOption[],
  efe: EFEComponents,
): string {
  if (policies.length === 0) return ''

  const lines: string[] = []

  // EFE summary
  lines.push(
    `EFE: epistemic=${efe.epistemicValue.toFixed(2)} pragmatic=${efe.pragmaticValue.toFixed(2)} ` +
    `novelty=${efe.noveltyBonus.toFixed(2)} precision=${efe.precision.toFixed(2)}`,
  )

  // Policy ranking
  const items = policies.map((p, i) =>
    `  ${i + 1}. ${escapeXml(p.toolName)} (prob=${(p.probability * 100).toFixed(0)}%, G=${p.expectedFreeEnergy.toFixed(4)})`,
  )

  const guidance = policies[0]!.probability > 0.3
    ? `Highest-probability action: ${escapeXml(policies[0]!.toolName)}. Consider this but exercise independent judgment.`
    : 'Distribution is flat — no single action dominates. Choose based on task context.'

  lines.push(guidance)
  lines.push(...items)

  return `<policy-guidance>\n${lines.join('\n')}\n</policy-guidance>`
}
