import { useTerminalSize } from './use-terminal-size.js'

/**
 * 根据终端行数、占比和最小/最大约束计算可用行数。
 * 用于对消息内容做视口感知的高度限制。
 *
 * @param terminalRows 终端当前行数
 * @param ratio 可用行数占比 (0-1)
 * @param minLines 最小行数（保证最低可用空间）
 * @param maxLines 可选最大行数上限
 */
export function viewportLines(
  terminalRows: number,
  ratio: number,
  minLines: number,
  maxLines?: number,
): number {
  const raw = Math.max(minLines, Math.floor(terminalRows * ratio))
  return maxLines !== undefined ? Math.min(raw, maxLines) : raw
}

export function latestHistoryItems<T>(items: readonly T[], maxItems: number): T[] {
  if (maxItems <= 0) return []
  return items.length > maxItems ? items.slice(-maxItems) : [...items]
}

/**
 * React hook：从当前终端尺寸计算视口可用行数。
 *
 * 用法：
 *   const maxLines = useViewportLines(0.6, 10)  // 60% 高度，最少 10 行
 */
export function useViewportLines(ratio: number, minLines: number, maxLines?: number): number {
  const { rows } = useTerminalSize()
  return viewportLines(rows, ratio, minLines, maxLines)
}
