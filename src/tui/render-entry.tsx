import { Box, Text } from 'ink'
import type { LogEntry } from './log-state.js'
import { ToolCard } from './tool-card.js'
import { StreamOutput } from './stream.js'

export function renderStaticEntry(entry: LogEntry, verbose: boolean) {
  switch (entry.type) {
    case 'tool':
      return <ToolCard key={entry.id} name={entry.toolName ?? ''} result={entry.content} isError={entry.isError} verbose={verbose} rawPath={entry.rawPath} />
    case 'checkpoint':
      return <Box key={entry.id} paddingX={2}><Text dimColor color="yellow">⚑ {entry.content}</Text></Box>
    case 'evidence':
      return <Box key={entry.id} paddingX={2} marginBottom={1} borderStyle="single" borderColor="green"><Text color="green">{entry.content}</Text></Box>
    default:
      return <StreamOutput key={entry.id} text={entry.content} isStreaming={false} />
  }
}
