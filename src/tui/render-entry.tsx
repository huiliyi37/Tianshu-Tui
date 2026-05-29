import { Box, Text } from 'ink'
import type { LogEntry } from './log-state.js'
import { ToolCard } from './tool-card.js'
import { ToolGroup } from './tool-group.js'
import { UserMessage } from './user-message.js'
import { AssistantMessage } from './assistant-message.js'
import { ThinkingMessage } from './thinking-message.js'
import { SystemMessage } from './system-message.js'
import { StreamOutput } from './stream.js'
import { QuestionCard } from './question-card.js'

export function renderStaticEntry(entry: LogEntry, verbose: boolean) {
  switch (entry.type) {
    case 'user_message':
      return <UserMessage key={entry.id} content={entry.content} />
    case 'thinking_message':
      return <ThinkingMessage key={entry.id} content={entry.content} />
    case 'assistant_message':
      return <AssistantMessage key={entry.id} content={entry.content} />
    case 'tool':
      if (entry.toolName === 'ask_user_question') {
        return <QuestionCard key={entry.id} question={entry.content} />
      }
      return <ToolCard key={entry.id} name={entry.toolName ?? ''} result={entry.content} isError={entry.isError} verbose={verbose} rawPath={entry.rawPath} />
    case 'tool_group':
      return <ToolGroup key={entry.id} tools={entry.children ?? []} verbose={verbose} />
    case 'checkpoint':
      return <Box key={entry.id} paddingX={2}><Text dimColor color="yellow">⚑ {entry.content}</Text></Box>
    case 'evidence':
      return <Box key={entry.id} paddingX={2} marginBottom={1} borderStyle="single" borderColor="green"><Text color="green">{entry.content}</Text></Box>
    case 'system':
      return <SystemMessage key={entry.id} content={entry.content} isError={entry.isError} />
    default:
      return <StreamOutput key={entry.id} text={entry.content} isStreaming={false} />
  }
}
