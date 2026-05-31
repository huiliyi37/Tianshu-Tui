import { Box, Text } from 'ink'
import { memo, useMemo } from 'react'
import { Markdown } from './markdown-render.js'
import { getTheme } from './theme.js'
import { gutterGlyph } from './gutter.js'
import { useTerminalSize } from './use-terminal-size.js'

interface StreamOutputProps {
  text: string
  isStreaming: boolean
}

/** During streaming, only render the tail window to avoid freezing on long output. */
function tailWindow(text: string, maxLines: number): { display: string; omitted: number } {
  const lines = text.split('\n')
  if (lines.length <= maxLines) return { display: text, omitted: 0 }
  return { display: lines.slice(-maxLines).join('\n'), omitted: lines.length - maxLines }
}

/**
 * StreamOutput — live streaming content during model generation.
 *
 * Uses a tail window during streaming to prevent event-loop stalls when
 * models produce very long output (GPT-5.5, DeepSeek). When the turn ends
 * the full content moves to <Static> and this unmounts.
 */
export const StreamOutput = memo(function StreamOutput({ text, isStreaming }: StreamOutputProps) {
  const theme = getTheme()
  const { rows } = useTerminalSize()
  // Reserve ~60% of terminal height for stream, min 8 lines
  const maxLines = Math.max(8, Math.floor(rows * 0.6))

  if (!text) {
    if (isStreaming) {
      return (
        <Box flexDirection="column" paddingX={1} marginBottom={1}>
          <Box flexDirection="row" gap={1}>
            <Text color={theme.assistantColor} bold>{gutterGlyph('assistant')}</Text>
            <Text dimColor>◌ Waiting for model…</Text>
          </Box>
        </Box>
      )
    }
    return null
  }

  const { display, omitted } = useMemo(
    () => isStreaming ? tailWindow(text, maxLines) : { display: text, omitted: 0 },
    [text, isStreaming, maxLines],
  )

  return (
    <Box flexDirection="column" paddingX={1} marginBottom={1}>
      <Box flexDirection="row" gap={1}>
        <Text color={theme.assistantColor} bold>{gutterGlyph('assistant')}</Text>
        <Box flexDirection="column" flexGrow={1}>
          {isStreaming && omitted > 0 && (
            <Text color={theme.muted}>(… {omitted} earlier lines)</Text>
          )}
          <Markdown text={display} />
          {isStreaming && <Text>{'▊'}</Text>}
        </Box>
      </Box>
    </Box>
  )
})
