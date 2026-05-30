import { Box, Text } from 'ink'
import { memo } from 'react'
import { Markdown } from './markdown-render.js'
import { getTheme } from './theme.js'
import { useTerminalSize } from './use-terminal-size.js'
import { useViewportLines } from './viewport.js'
import { gutterGlyph } from './gutter.js'
import { computeBudget } from './dynamic-budget.js'

/**
 * StreamOutput needs to know how many ToolCards are live so it can
 * allocate its portion of the dynamic-zone budget. When multiple
 * ToolCards are active, StreamOutput shrinks to leave room.
 */
interface StreamOutputProps {
  text: string
  isStreaming: boolean
  liveToolCount?: number
}

/**
 * Compute max stream lines using the unified budget allocator.
 * Falls back to single-card budget when liveToolCount is not provided.
 */
function computeMaxStreamLines(termRows: number, liveToolCount: number): number {
  const { streamLines } = computeBudget(termRows, liveToolCount)
  return streamLines
}

/**
 * StreamOutput — live streaming content during model generation.
 *
 * No border box: a bordered box forces Ink to re-measure the whole block every
 * delta, so long fast streams (DeepSeek) jitter. claude-code style — gutter glyph
 * + plain rows flowing down. Tail window caps the active region height; when the
 * turn ends the full content moves to <Static> and this unmounts.
 */
export const StreamOutput = memo(function StreamOutput({ text, isStreaming, liveToolCount = 0 }: StreamOutputProps) {
  const theme = getTheme()
  const { rows } = useTerminalSize()
  const maxLines = useViewportLines(0.6, 8, computeMaxStreamLines(rows, liveToolCount))

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
  liveToolCount?: number
}
