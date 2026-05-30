import { Box, Text } from 'ink'
import { memo } from 'react'
import { Markdown } from './markdown-render.js'
import { getTheme } from './theme.js'
import { useTerminalSize } from './use-terminal-size.js'
import { useViewportLines } from './viewport.js'
import { gutterGlyph } from './gutter.js'

/**
 * Reserve lines for other dynamic-zone components.
 * Computes from cappedCollapsedLines(terminalRows) + thinking(1) + chrome(5).
 * This prevents the dynamic zone from exceeding terminal height and
 * triggering Ink differential-rendering flicker.
 */
const DYNAMIC_CHROME = 6  // ThinkingCollapser(1) + GlanceBar(1) + InputBar(2) + margins(2)

function computeMaxStreamLines(termRows: number): number {
  const toolCardLines = Math.min(15, Math.max(3, Math.floor(termRows / 2) - 2))
  return Math.max(8, termRows - toolCardLines - DYNAMIC_CHROME)
}

/**
 * StreamOutput — live streaming content during model generation.
 *
 * No border box: a bordered box forces Ink to re-measure the whole block every
 * delta, so long fast streams (DeepSeek) jitter. claude-code style — gutter glyph
 * + plain rows flowing down. Tail window caps the active region height; when the
 * turn ends the full content moves to <Static> and this unmounts.
 */
export const StreamOutput = memo(function StreamOutput({ text, isStreaming }: StreamOutputProps) {
  const theme = getTheme()
  const { rows } = useTerminalSize()
  const maxLines = useViewportLines(0.6, 8, computeMaxStreamLines(rows))

  if (!text) return null

  let displayText = text
  let omittedLines = 0
  if (isStreaming) {
    const lines = text.split('\n')
    if (lines.length > maxLines) {
      omittedLines = lines.length - maxLines
      displayText = lines.slice(-maxLines).join('\n')
    }
  }

  return (
    <Box flexDirection="column" paddingX={1} marginBottom={1}>
      <Box flexDirection="row" gap={1}>
        <Text color={theme.assistantColor} bold>{gutterGlyph('assistant')}</Text>
        <Box flexDirection="column" flexGrow={1}>
          {isStreaming && omittedLines > 0 && (
            <Text color={theme.muted}>(… {omittedLines} earlier lines)</Text>
          )}
          <Markdown text={displayText} />
          {isStreaming && <Text>{'▊'}</Text>}
        </Box>
      </Box>
    </Box>
  )
})

interface StreamOutputProps {
  text: string
  isStreaming: boolean
}
