import { Box, Text } from 'ink'
import { memo } from 'react'
import { getTheme } from './theme.js'
import { Markdown } from './markdown-render.js'
import { gutterGlyph } from './gutter.js'

interface AssistantMessageProps {
  content: string
}

/**
 * Maximum number of logical lines passed to <Markdown> for a Static entry.
 * Without this cap, long model responses (5–10k+ chars of analysis) create
 * hundreds of React elements + Yoga layout nodes synchronously inside <Static>,
 * which blocks the Node event loop so hard that even SIGINT can't land — the
 * same symptom already documented in pushAssistantEntry's thinking cap.
 * The streaming viewport (StreamOutput) already limits live display; this
 * cap limits the archival Static render.
 */
/** Raised from 80 to 200 so most replies render fully in terminal scrollback.
 *  Replies >200 lines are chunked by pushAssistantEntry into multiple entries,
 *  keeping each Static unit under the event-loop safety ceiling. */
const MAX_STATIC_LINES = 200

/**
 * Assistant content message — rendered in <Static> list (print-and-forget to
 * terminal scrollback). No border box: a bordered box welds the whole reply into
 * one indivisible render unit the terminal can't paginate, so long replies stack
 * and overflow. claude-code style — gutter glyph + plain text rows that flow into
 * native terminal scrollback.
 */
export const AssistantMessage = memo(function AssistantMessage({ content }: AssistantMessageProps) {
  const theme = getTheme()

  if (!content) return null

  const lines = content.split('\n')
  const isLong = lines.length > MAX_STATIC_LINES
  const omittedLines = isLong ? lines.length - MAX_STATIC_LINES : 0
  const displayContent = isLong ? lines.slice(-MAX_STATIC_LINES).join('\n') : content

  return (
    <Box flexDirection="column" paddingX={1} marginTop={1} marginBottom={1}>
      <Box flexDirection="row" gap={1}>
        <Text color={theme.assistantColor} bold>{gutterGlyph('assistant')}</Text>
        <Box flexDirection="column" flexGrow={1}>
          <Text color={theme.assistantColor} dimColor>Rivet</Text>
          {omittedLines > 0 && (
            <Text color={theme.muted}>(… {omittedLines} earlier lines omitted)</Text>
          )}
          <Markdown text={displayContent} />
        </Box>
      </Box>
    </Box>
  )
})
