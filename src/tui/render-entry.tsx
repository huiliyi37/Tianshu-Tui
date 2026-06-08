import { Box, Text } from 'ink'
import { memo } from 'react'
import type { LogEntry } from './log-state.js'
import { getTheme } from './theme.js'
import { ToolCard } from './tool-card.js'
import { ToolGroup } from './tool-group.js'
import { UserMessage } from './user-message.js'
import { AssistantMessage } from './assistant-message.js'
import { ThinkingMessage } from './thinking-message.js'
import { SystemMessage } from './system-message.js'
import { StreamOutput } from './stream.js'
import { QuestionCard } from './question-card.js'
import { decodeTeamPanelModel } from './team-panel-model.js'
import { TeamPanel } from './team-panel.js'

const TurnSummary = memo(function TurnSummary({ content }: { content: string }) {
  const theme = getTheme()
  // No rule line (the footer GlanceBar owns the divider). Right-aligned, dim —
  // a quiet end-of-turn ledger mark, not a banner. justifyContent pushes it to
  // the right edge so it reads as a margin note on the turn that just closed.
  return (
    <Box paddingX={1} marginTop={1} justifyContent="flex-end">
      <Text color={theme.dim}>✦ {content}</Text>
    </Box>
  )
})

type EntryRenderer = (entry: LogEntry, verbose: boolean) => ReturnType<typeof Box>

const RENDER_MAP: Record<string, EntryRenderer> = {
  user_message: (e) => <UserMessage key={e.id} content={e.content} />,
  thinking_message: (e) => <ThinkingMessage key={e.id} content={e.content} />,
  assistant_message: (e) => <AssistantMessage key={e.id} content={e.content} />,
  tool: (e, verbose) => {
    if (e.toolName === 'ask_user_question') {
      return <QuestionCard key={e.id} question={e.content} />
    }
    if (e.toolName === 'team_orchestrate') {
      const model = decodeTeamPanelModel(e.content)
      if (model) return <TeamPanel key={e.id} model={model} />
    }
    return <ToolCard key={e.id} name={e.toolName ?? ''} result={e.content} isError={e.isError} verbose={verbose} rawPath={e.rawPath} depth={e.depth} />
  },
  tool_group: (e, verbose) => <ToolGroup key={e.id} tools={e.children ?? []} verbose={verbose} />,
  checkpoint: (e) => <Box key={e.id} paddingX={2}><Text color={getTheme().muted} bold>⚑ {e.content}</Text></Box>,
  evidence: (e) => <Box key={e.id} paddingX={2} marginBottom={1} borderStyle="single" borderColor="green"><Text color="green">{e.content}</Text></Box>,
  system: (e) => <SystemMessage key={e.id} content={e.content} isError={e.isError} />,
  turn_summary: (e) => <TurnSummary key={e.id} content={e.content} />,
}

export function renderStaticEntry(entry: LogEntry, verbose: boolean) {
  const renderer = RENDER_MAP[entry.type]
  if (renderer) return renderer(entry, verbose)
  return <StreamOutput key={entry.id} text={entry.content} isStreaming={false} />
}

/**
 * 为 Static 列表项生成稳定的 memo key。
 * 包含 type + id + content 前缀，确保内容变化时触发正确更新。
 */
export function renderMemoKey(entry: LogEntry): string {
  const contentPreview = entry.content.slice(0, 40).replace(/\n/g, '\\n')
  return `${entry.type}:${entry.id}:${contentPreview}`
}
