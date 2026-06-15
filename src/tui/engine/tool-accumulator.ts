/**
 * 单个工具流式输出累加器的字节上限。超限时保留尾部（live 卡片只展示末尾），
 * 防止超大输出工具（如 cat 100MB 文件逐 chunk 上行）撑爆内存。终态结果
 * 提交到 scrollback 时用完整 result 字符串，不受此 cap 影响。
 */
export const TOOL_ACCUMULATOR_MAX_BYTES = 64 * 1024

/**
 * 截断工具累加器到字节上限，保留尾部并标注省略前缀。
 * 字节而非字符计数——内存压力来自字节数而非逻辑字符数。
 */
export function capToolAccumulator(text: string, maxBytes: number): string {
  if (text.length <= maxBytes) return text
  const tail = text.slice(-maxBytes)
  const nl = tail.indexOf('\n')
  return `… [truncated ${text.length - maxBytes} chars]\n${nl >= 0 ? tail.slice(nl + 1) : tail}`
}
