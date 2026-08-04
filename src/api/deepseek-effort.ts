/**
 * DeepSeek V4 effort 线上归一化。
 *
 * Chat Completions 官方只认 `low | high | max`（见 api-docs thinking_mode）。
 * 天枢对外仍保留 `medium`（UI / config / auto-reasoning），线上映射为 `low`——
 * Flash 上 `low` 是真实独立档；Pro 上 `low` 服务端再抬到 `high`。
 *
 * Responses API 另有一套映射（medium→high），见 {@link mapDeepSeekResponsesEffort}。
 */

export type DeepSeekChatEffort = 'low' | 'high' | 'max'
export type DeepSeekResponsesEffort = 'none' | 'low' | 'medium' | 'high' | 'max'

/** 无效采样字段：thinking 开启时服务端忽略，发出去只浪费字节并误导调用方。 */
export const DEEPSEEK_THINKING_IGNORED_SAMPLING = [
  'temperature',
  'top_p',
  'presence_penalty',
  'frequency_penalty',
] as const

/**
 * 把 Rivet 内部 effort 归一到 Chat Completions 线上合法值。
 * `off` / 空 → undefined（由调用方决定是否省略字段或关 thinking）。
 * `medium` → `low`（对外可保留 medium 语义，线上走 Flash 廉价档）。
 */
export function normalizeDeepSeekChatEffort(
  effort: string | undefined | null,
): DeepSeekChatEffort | undefined {
  if (effort == null || effort === '' || effort === 'off') return undefined
  switch (effort) {
    case 'low':
    case 'medium':
      return 'low'
    case 'high':
      return 'high'
    case 'max':
    case 'xhigh':
      return 'max'
    default:
      // 未知值 fail-open 到 high（服务端默认），避免误发 medium 等非法字面量。
      return 'high'
  }
}

/**
 * Responses API `reasoning.effort` 映射。
 * 官方：none 关思考；minimal/low→low；medium/high/xhigh→high；max→max。
 * 天枢 medium 在 Responses 栈仍发 medium（服务端抬到 high），与 Chat 栈 medium→low 刻意不同——
 * Responses 目前仅 Flash，medium 是合法请求值。
 */
export function mapDeepSeekResponsesEffort(
  effort: string | undefined | null,
): DeepSeekResponsesEffort {
  if (effort == null || effort === '' || effort === 'off') return 'none'
  switch (effort) {
    case 'low':
      return 'low'
    case 'medium':
      return 'medium'
    case 'high':
    case 'xhigh':
      return 'high'
    case 'max':
      return 'max'
    default:
      return 'high'
  }
}

/** thinking 开启时从请求体删除无效采样字段（原地 mutate body 的浅拷贝调用方）。 */
export function stripThinkingSamplingFields(
  body: Record<string, unknown>,
): void {
  for (const key of DEEPSEEK_THINKING_IGNORED_SAMPLING) {
    delete body[key]
  }
}

/** 是否应对该 provider 做 DeepSeek Chat effort 归一化。 */
export function isDeepSeekEffortProvider(providerName: string | undefined): boolean {
  if (!providerName) return false
  return providerName === 'deepseek'
    || providerName === 'siliconflow'
    || /deepseek/i.test(providerName)
}
