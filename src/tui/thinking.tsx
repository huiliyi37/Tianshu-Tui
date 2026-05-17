import { useState } from 'react'
import { Box, Text, useInput } from 'ink'

interface ThinkingCollapserProps {
  thinking: string
  isStreaming: boolean
  focused?: boolean
}

const MAX_THINKING_DISPLAY = 50_000

export function formatDuration(ms: number): string {
  const totalSeconds = Math.floor(ms / 1000)
  const minutes = Math.floor(totalSeconds / 60)
  const seconds = totalSeconds % 60
  return minutes > 0 ? `${minutes}m ${seconds}s` : `${seconds}s`
}

export function formatThinkingSize(chars: number): string {
  if (chars < 1000) return `${chars} chars`
  return `${(chars / 1000).toFixed(1).replace(/\.0$/, '')}k`
}

function truncateThinking(text: string): string {
  if (text.length <= MAX_THINKING_DISPLAY) return text
  return text.slice(0, MAX_THINKING_DISPLAY) + `\n... (${text.length - MAX_THINKING_DISPLAY} more characters)`
}

export function ThinkingCollapser({ thinking, isStreaming, focused }: ThinkingCollapserProps) {
  const [expanded, setExpanded] = useState(false)

  useInput((_input, key) => {
    if (focused && key.tab) {
      setExpanded(v => !v)
    }
  })

  if (!thinking && !isStreaming) return null

  return (
    <Box flexDirection="column" paddingX={2}>
      <Text dimColor>
        {expanded ? '▾' : '▸'} Thinking{isStreaming ? '...' : ''} (Tab to {expanded ? 'collapse' : 'expand'})
      </Text>
      {expanded && (
        <Box paddingLeft={2} borderStyle="single" borderColor="gray">
          <Text dimColor>{truncateThinking(thinking)}</Text>
        </Box>
      )}
    </Box>
  )
}
