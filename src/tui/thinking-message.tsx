import { Box, Text } from 'ink'
import { memo } from 'react'
import stringWidth from 'string-width'
import { formatThinkingSize } from './thinking.js'
import { useViewportLines } from './viewport.js'
import { useTerminalSize } from './use-terminal-size.js'
import { getTheme } from './theme.js'
import { gutterGlyph } from './gutter.js'

interface ThinkingMessageProps {
  content: string
}

/**
 * Calculate the number of physical lines a string occupies in a terminal.
 * Each logical line may span multiple physical lines if it's wider than terminal columns.
 * CJK characters count as 2 cells each.
 */
export function countPhysicalLines(text: string, columns: number): number {
  if (text.length === 0) return 0
  if (columns <= 0) columns = 80 // fallback for unreported terminal size
  const lines = text.split('\n')
  let total = 0
  for (const line of lines) {
    if (line.length === 0) {
      total += 1 // empty line still takes one physical line
    } else {
      const width = stringWidth(line)
      total += Math.max(1, Math.ceil(width / columns))
    }
  }
  return total
}

/**
 * Static thinking message — rendered in <Static> list.
 *
 * 设计要点：
 * 1. 非交互 — Static 列表中的条目不支持 useInput
 * 2. 视口自适应 — 高度上限 = 40% 终端行数，最小 3 行，按物理行测量（CJK 宽字符）
 * 3. 尾部保留 — 截断时保留最新内容（底部），省略指示器在顶部
 *
 * 从 AssistantMessage 中拆出：thinking 和 content 不再混在同一个
 * bordered box 内，各自独立渲染，高度各自受限，避免总高度溢出终端。
 */
export const ThinkingMessage = memo(function ThinkingMessage({ content }: ThinkingMessageProps) {
  const theme = getTheme()
  const { columns: rawColumns } = useTerminalSize()
  const columns = rawColumns > 0 ? rawColumns : 80
  const maxPhysicalLines = useViewportLines(0.4, 3)
  const lines = content.split('\n')
  const totalPhysicalLines = countPhysicalLines(content, columns)
  const totalLogicalLines = lines.length

  if (totalPhysicalLines <= maxPhysicalLines) {
    return (
      <Box flexDirection="column" paddingX={2}>
        <Text color={theme.dim}>{gutterGlyph('thinking')} <Text italic>Thinking</Text> ({formatThinkingSize(content.length)})</Text>
        <Box paddingLeft={2} flexDirection="column">
          {lines.map((line, i) => (
            <Text key={i} color={theme.muted}>{line}</Text>
          ))}
        </Box>
      </Box>
    )
  }

  // Need to truncate: keep the bottom portion that fits within maxPhysicalLines.
  // Walk backwards from the end, accumulating physical lines until we exceed maxPhysicalLines.
  let accumulated = 0
  let cutoffIndex = lines.length // exclusive index where we start showing lines
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i]!
    const lineWidth = line.length === 0 ? 1 : Math.max(1, Math.ceil(stringWidth(line) / columns))
    if (accumulated + lineWidth > maxPhysicalLines) break
    accumulated += lineWidth
    cutoffIndex = i
  }
  const omitted = cutoffIndex
  const visibleLines = lines.slice(cutoffIndex)
  return (
    <Box flexDirection="column" paddingX={2}>
      <Text color={theme.dim}>{gutterGlyph('thinking')} <Text italic>Thinking</Text> ({formatThinkingSize(content.length)}, {omitted} earlier lines omitted)</Text>
      <Box paddingLeft={2} flexDirection="column">
        <Text color={theme.muted}>…</Text>
        {visibleLines.map((line, i) => (
          <Text key={i} color={theme.muted}>{line}</Text>
        ))}
      </Box>
    </Box>
  )
})
