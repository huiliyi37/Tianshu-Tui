import { Box, Text } from 'ink'
import { memo, useState, useEffect } from 'react'
import { getTheme } from './theme.js'

export interface ToolCallItem {
  id: string
  name: string
  label: string
  done: boolean
  error: boolean
}

interface AgentStatusProps {
  isStreaming: boolean
  startMs: number
  tokenEstimate: number
  thinkingTime: number
  tools: ToolCallItem[]
}

const SPINNER_FRAMES = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏']

const MAX_VISIBLE_ITEMS = 8

function formatDuration(ms: number): string {
  const totalSec = Math.max(0, Math.round(ms / 1000))
  if (totalSec < 60) return `${totalSec}s`
  const m = Math.floor(totalSec / 60)
  const s = totalSec % 60
  return `${m}m ${s}s`
}

function formatTokenCount(n: number): string {
  if (n < 1000) return String(n)
  if (n < 1_000_000) return `${(n / 1000).toFixed(1)}k`
  return `${(n / 1_000_000).toFixed(1)}M`
}

function truncate(s: string, max: number): string {
  return s.length > max ? s.slice(0, max - 1) + '…' : s
}

function phaseLabel(tools: ToolCallItem[], isThinking: boolean): string {
  if (isThinking) return 'Thinking…'

  const pending = tools.filter(t => !t.done)
  if (pending.length === 0 && tools.length === 0) return 'Processing…'
  if (pending.length === 0) return 'Wrapping up…'

  const latest = pending[pending.length - 1]!
  switch (latest.name) {
    case 'read_file': case 'grep': case 'glob': case 'diff':
      return 'Searching…'
    case 'write_file': case 'edit_file':
      return 'Writing…'
    case 'bash':
      return 'Running…'
    case 'run_tests':
      return 'Testing…'
    case 'delegate_task':
      return 'Delegating…'
    default:
      return 'Working…'
  }
}

function pathBasename(value: unknown): string {
  return String(value ?? '').replace(/^.*[\/]/, '')
}

function formatInputValue(value: unknown): string {
  if (typeof value === 'string') return JSON.stringify(value)
  return String(value)
}

function readFileDetail(input: Record<string, unknown>): string {
  const details = Object.entries(input)
    .filter(([key]) => key !== 'file_path')
    .map(([key, value]) => `${key}=${formatInputValue(value)}`)

  return details.length > 0 ? ` · ${truncate(details.join(' '), 60)}` : ''
}

function toolLabel(name: string, input: Record<string, unknown>): string {
  switch (name) {
    case 'read_file': return `read ${truncate(pathBasename(input.file_path), 45)}${readFileDetail(input)}`
    case 'write_file': return `write ${truncate(pathBasename(input.file_path), 45)}`
    case 'edit_file': return `edit ${truncate(pathBasename(input.file_path), 45)}`
    case 'bash': return truncate(String(input.command ?? '').split('\n')[0] ?? '', 55)
    case 'grep': return `grep ${truncate(String(input.pattern ?? ''), 35)}`
    case 'glob': return `glob ${truncate(String(input.pattern ?? ''), 35)}`
    case 'diff': return 'diff'
    case 'run_tests': return 'run tests'
    case 'delegate_task': return truncate(String(input.objective ?? ''), 50)
    default: return name
  }
}

export { toolLabel }

export const AgentStatus = memo(function AgentStatus({ isStreaming, startMs, tokenEstimate, thinkingTime, tools }: AgentStatusProps) {
  const [tick, setTick] = useState(0)

  useEffect(() => {
    if (!isStreaming) return
    const id = setInterval(() => setTick(t => t + 1), 120)
    return () => clearInterval(id)
  }, [isStreaming])

  if (!isStreaming) return null

  const theme = getTheme()
  const now = Date.now()
  const elapsed = now - startMs
  const spinner = SPINNER_FRAMES[tick % SPINNER_FRAMES.length]!
  const isThinking = thinkingTime > 0 && tools.length === 0
  const phase = phaseLabel(tools, isThinking)

  const parts: string[] = [formatDuration(elapsed)]
  if (tokenEstimate > 0) parts.push(`↓ ${formatTokenCount(tokenEstimate)} tokens`)
  if (thinkingTime > 0 && !isThinking) parts.push(`thought ${Math.round(thinkingTime / 1000)}s`)

  // Show pending items first, then recently completed
  const pending = tools.filter(t => !t.done)
  const completed = tools.filter(t => t.done)
  const visible = [...pending, ...completed.slice(-Math.max(0, MAX_VISIBLE_ITEMS - pending.length))]
  const hidden = completed.length - Math.max(0, MAX_VISIBLE_ITEMS - pending.length)

  return (
    <Box flexDirection="column" paddingX={1}>
      <Box>
        <Text bold color={theme.primary}>{spinner} {phase}</Text>
        <Text dimColor> ({parts.join(' · ')})</Text>
      </Box>
      {visible.length > 0 && (
        <Box flexDirection="column" paddingLeft={2}>
          {visible.map((tc, i) => (
            <Box key={tc.id}>
              <Text dimColor>{i === 0 ? '⎿ ' : '  '}</Text>
              <Text color={tc.error ? 'red' : tc.done ? 'green' : undefined}>
                {tc.done ? (tc.error ? '✗' : '✔') : '◻'}
              </Text>
              <Text dimColor={tc.done && !tc.error}> {tc.label}</Text>
            </Box>
          ))}
          {hidden > 0 && (
            <Text dimColor>  … +{hidden} completed</Text>
          )}
        </Box>
      )}
    </Box>
  )
})
