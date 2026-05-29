import { Box, Text } from 'ink'
import { memo } from 'react'
import { getTheme } from './theme.js'
import { Markdown } from './markdown-render.js'
import { useViewportLines } from './viewport.js'

interface AssistantMessageProps {
  content: string
}

/**
 * Assistant content message — rendered in <Static> list.
 *
 * Thinking 已拆分为独立的 ThinkingMessage 条目，不再与本组件混排。
 * 内容高度自适应终端视口：上限 = 60% 行数，最小 10 行。
 * 超出时保留尾部内容（最新），省略指示器在顶部。
 */
export const AssistantMessage = memo(function AssistantMessage({ content }: AssistantMessageProps) {
  const theme = getTheme()
  const maxLines = useViewportLines(0.6, 10)

  if (!content) return null

  const lines = content.split('\n')
  let displayText = content
  let omittedLines = 0
  if (lines.length > maxLines) {
    omittedLines = lines.length - maxLines
    displayText = lines.slice(-maxLines).join('\n')
  }

  return (
    <Box flexDirection="column" paddingX={1} marginBottom={1}>
      <Box borderStyle="round" borderColor={theme.assistantColor} paddingX={1} flexDirection="column">
        <Box flexDirection="row" gap={1} marginBottom={1}>
          <Text color={theme.assistantColor} bold>{'●'}</Text>
          <Text color={theme.assistantColor} bold>Assistant</Text>
        </Box>
        <Box flexDirection="column" paddingLeft={2}>
          {omittedLines > 0 && (
            <Text color={theme.muted}>… {omittedLines} earlier lines omitted</Text>
          )}
          <Markdown text={displayText} />
        </Box>
      </Box>
    </Box>
  )
})
