/**
 * P2 — 96K 思维链上限看门狗（effort 双向调度收口，见
 * src/agent/effort-routing.ts escalateOnHardSignal 头注释）。DeepSeek 没有
 * Anthropic `budget_tokens` 式的原生"最大推理 token"参数——升到 max 之后思维链
 * 可以无限跑，唯一能收口的手段是客户端自己边收流边数、越界就主动收口。
 *
 * chars/4 ≈ tokens 是仓库既有估算惯例（如 tool-pipeline.ts 的工具输出字符预算），
 * 这里沿用同一惯例，不引入新的计数方式。
 */

/** 默认思维链上限（token）。0 关闭该检查（完全不设上限，回退旧行为）。 */
export const DEFAULT_REASONING_CHAIN_CAP_TOKENS = 96_000

/**
 * @param accumulatedChars 当前已收到的 reasoning_content 累计字符数
 * @param capTokens 上限（token）。<=0 表示关闭检查。
 */
export function shouldCapReasoning(
  accumulatedChars: number,
  capTokens: number = DEFAULT_REASONING_CHAIN_CAP_TOKENS,
): boolean {
  if (capTokens <= 0) return false
  return accumulatedChars / 4 >= capTokens
}
