import { Box, Text } from 'ink'
import { memo } from 'react'
import { formatThinkingSize } from './thinking.js'
import { useViewportLines } from './viewport.js'
import { getTheme } from './theme.js'

interface ThinkingMessageProps {
  content: string
}

/**
 * Static thinking message — rendered in <Static> list.
 *
 * 设计要点：
 * 1. 非交互 — Static 列表中的条目不支持 useInput
 * 2. 视口自适应 — 高度上限 = 40% 终端行数，最小 3 行
 * 3. 尾部保留 — 截断时保留最新内容（底部），省略指示器在顶部
 *
 * 从 AssistantMessage 中拆出：thinking 和 content 不再混在同一个
 * bordered box 内，各自独立渲染，高度各自受限，避免总高度溢出终端。
 */
export const ThinkingMessage = memo(function ThinkingMessage({ content }: ThinkingMessageProps) {
  const theme = getTheme()
  const maxLines = useViewportLines(0.4, 3)
  const lines = content.split('\n')
  const totalLines = lines.length

  if (totalLines <= maxLines) {
    return (
      <Box flexDirection="column" paddingX={2}>
        <Text color={theme.muted}>▸ Thinking ({formatThinkingSize(content.length)})</Text>
        <Box paddingLeft={2} flexDirection="column">
          {lines.map((line, i) => (
            <Text key={i} color={theme.muted}>{line}</Text>
          ))}
        </Box>
      </Box>
    )
  }

  const omitted = totalLines - maxLines
  const visibleLines = lines.slice(-maxLines)
  return (
    <Box flexDirection="column" paddingX={2}>
      <Text color={theme.muted}>▸ Thinking ({formatThinkingSize(content.length)}, {omitted} earlier lines omitted)</Text>
      <Box paddingLeft={2} flexDirection="column">
        <Text color={theme.muted}>…</Text>
        {visibleLines.map((line, i) => (
          <Text key={i} color={theme.muted}>{line}</Text>
        ))}
      </Box>
    </Box>
  )
})
