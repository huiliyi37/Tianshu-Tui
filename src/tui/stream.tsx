import { Box, Text } from 'ink'
import { memo } from 'react'
import { Markdown } from './markdown-render.js'
import { getTheme } from './theme.js'
import { gutterGlyph } from './gutter.js'

interface StreamOutputProps {
  text: string
  isStreaming: boolean
}

/**
 * StreamOutput — live streaming content during model generation.
 *
 * NOTE (2026-06-05): live-zone height is NOT bounded here. The correct fix for
 * runaway scroll is layout (root height={termRows} + dynamic zone flexGrow
 * justifyContent="flex-end" + <Static> as an absolute direct child), NOT a
 * per-row tail window — see memory `dynamic-budget-was-a-layout-workaround`
 * and docs/known-issues/HANDOFF-2026-06-05-steer-and-render-fixes.md (真凶②).
 * When the turn ends the full content moves to <Static> and this unmounts.
 */
export const StreamOutput = memo(function StreamOutput({ text, isStreaming }: StreamOutputProps) {
  const theme = getTheme()

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

  return (
    <Box flexDirection="column" paddingX={1} marginBottom={1}>
      <Box flexDirection="row" gap={1}>
        <Text color={theme.assistantColor} bold>{gutterGlyph('assistant')}</Text>
        <Box flexDirection="column" flexGrow={1}>
          <Markdown text={text} />
          {isStreaming && <Text>{'▊'}</Text>}
        </Box>
      </Box>
    </Box>
  )
})
