import { Box, Text, useInput } from 'ink'
import { memo, useState } from 'react'
import { getTheme } from './theme.js'
import { Markdown } from './markdown-render.js'
import { formatThinkingSize } from './thinking.js'

interface AssistantMessageProps {
  content: string
  thinking?: string
}

const THINKING_PREVIEW_LINES = 3
const THINKING_MAX_EXPANDED_LINES = 30
const CONTENT_MAX_LINES = 40

function truncateLines(text: string, max: number): { text: string; omitted: number } {
  if (!text) return { text, omitted: 0 }
  const lines = text.split('\n')
  if (lines.length <= max) return { text, omitted: 0 }
  const kept = lines.slice(-max)
  return { text: kept.join('\n'), omitted: lines.length - max }
}

export const AssistantMessage = memo(function AssistantMessage({ content, thinking }: AssistantMessageProps) {
  const theme = getTheme()
  const [thinkingExpanded, setThinkingExpanded] = useState(false)

  useInput((_input, key) => {
    if (key.tab && thinking) {
      setThinkingExpanded(v => !v)
    }
  })

  if (!content && !thinking) return null

  const truncatedContent = truncateLines(content, CONTENT_MAX_LINES)

  // Thinking-only turn: model produced reasoning but no text output
  if (!content && thinking) {
    const lines = thinking.split('\n')
    const maxLines = thinkingExpanded ? THINKING_MAX_EXPANDED_LINES : THINKING_PREVIEW_LINES
    const visibleLines = lines.slice(0, maxLines)
    const omitted = Math.max(0, lines.length - maxLines)
    return (
      <Box flexDirection="column" paddingX={1} marginBottom={1}>
        <Box borderStyle="round" borderColor={theme.assistantColor} paddingX={1} flexDirection="column">
          <Box flexDirection="row" gap={1} marginBottom={1}>
            <Text color={theme.assistantColor} bold>{'●'}</Text>
            <Text color={theme.assistantColor} bold>Assistant</Text>
            <Text color={theme.assistantColor} italic>(thinking only · {formatThinkingSize(thinking.length)})</Text>
            <Text dimColor> Tab to {thinkingExpanded ? 'collapse' : 'expand'}</Text>
          </Box>
          {visibleLines.map((line, i) => (
            <Box key={i} flexDirection="row" paddingLeft={3}>
              <Text dimColor>{line}</Text>
            </Box>
          ))}
          {omitted > 0 && (
            <Box paddingLeft={3}>
              <Text dimColor>… {omitted} more lines</Text>
            </Box>
          )}
        </Box>
      </Box>
    )
  }

  // Content + thinking: show content, with collapsible thinking section
  if (content && thinking) {
    const thinkLines = thinking.split('\n')
    const maxLines = thinkingExpanded ? THINKING_MAX_EXPANDED_LINES : THINKING_PREVIEW_LINES
    const visibleThink = thinkLines.slice(0, maxLines)
    const omitted = Math.max(0, thinkLines.length - maxLines)
    return (
      <Box flexDirection="column" paddingX={1} marginBottom={1}>
        <Box borderStyle="round" borderColor={theme.assistantColor} paddingX={1} flexDirection="column">
          <Box flexDirection="row" gap={1} marginBottom={1}>
            <Text color={theme.assistantColor} bold>{'●'}</Text>
            <Text color={theme.assistantColor} bold>Assistant</Text>
          </Box>
          <Box flexDirection="column" paddingLeft={1} marginBottom={1}>
            <Text dimColor>
              {thinkingExpanded ? '▾' : '▸'} Thinking ({formatThinkingSize(thinking.length)})
              <Text dimColor> Tab to {thinkingExpanded ? 'collapse' : 'expand'}</Text>
            </Text>
            {visibleThink.map((line, i) => (
              <Box key={i} paddingLeft={2}>
                <Text dimColor>{line}</Text>
              </Box>
            ))}
            {omitted > 0 && (
              <Box paddingLeft={2}>
                <Text dimColor>… {omitted} more lines</Text>
              </Box>
            )}
          </Box>
          <Box flexDirection="column" paddingLeft={2}>
            {truncatedContent.omitted > 0 && (
              <Text dimColor>… {truncatedContent.omitted} earlier lines omitted</Text>
            )}
            <Markdown text={truncatedContent.text} />
          </Box>
        </Box>
      </Box>
    )
  }

  return (
    <Box flexDirection="column" paddingX={1} marginBottom={1}>
      <Box borderStyle="round" borderColor={theme.assistantColor} paddingX={1} flexDirection="column">
        <Box flexDirection="row" gap={1} marginBottom={1}>
          <Text color={theme.assistantColor} bold>{'●'}</Text>
          <Text color={theme.assistantColor} bold>Assistant</Text>
        </Box>
        <Box flexDirection="column" paddingLeft={2}>
          {truncatedContent.omitted > 0 && (
            <Text dimColor>… {truncatedContent.omitted} earlier lines omitted</Text>
          )}
          <Markdown text={truncatedContent.text} />
        </Box>
      </Box>
    </Box>
  )
})
