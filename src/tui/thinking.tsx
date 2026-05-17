import { useState, useEffect, useRef } from 'react'
import { Box, Text, useInput } from 'ink'

interface ThinkingStatusOptions {
  isStreaming: boolean
  elapsedMs: number
  completedDurationMs?: number
  stale?: boolean
}

export function thinkingStatusLabel(options: ThinkingStatusOptions): string {
  if (options.stale && options.isStreaming) return 'waiting for response…'
  if (options.isStreaming) return formatDuration(options.elapsedMs)
  if (options.completedDurationMs !== undefined) return `completed in ${formatDuration(options.completedDurationMs)}`
  return 'completed'
}

interface ThinkingCollapserProps {
  thinking: string
  isStreaming: boolean
  focused?: boolean
  completedDurationMs?: number
}

const MAX_THINKING_DISPLAY = 50_000

export function formatDuration(ms: number): string {
  const totalSeconds = Math.max(0, Math.round(ms / 1000))
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

export function ThinkingCollapser({ thinking, isStreaming, focused = false, completedDurationMs }: ThinkingCollapserProps) {
  const [expanded, setExpanded] = useState(false)
  const [elapsed, setElapsed] = useState(0)
  const [stale, setStale] = useState(false)
  const startRef = useRef(0)
  const thinkingRef = useRef(thinking)
  const staleCheckRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  useEffect(() => {
    if (isStreaming && thinking && startRef.current === 0) {
      startRef.current = Date.now()
      setElapsed(0)
      setExpanded(true) // auto-expand on new thinking
    }
    if (!isStreaming) {
      startRef.current = 0
      setStale(false)
    }
  }, [isStreaming, thinking])

  // Track if thinking content stops arriving while streaming is active
  useEffect(() => {
    thinkingRef.current = thinking
    if (isStreaming && thinking) {
      setStale(false)
      if (staleCheckRef.current) clearTimeout(staleCheckRef.current)
      staleCheckRef.current = setTimeout(() => {
        setStale(true)
      }, 5000)
    }
    return () => {
      if (staleCheckRef.current) clearTimeout(staleCheckRef.current)
    }
  }, [isStreaming, thinking])

  useEffect(() => {
    if (!isStreaming) return
    const id = setInterval(() => {
      if (startRef.current > 0) {
        setElapsed(Date.now() - startRef.current)
      }
    }, 1000)
    return () => clearInterval(id)
  }, [isStreaming])

  useInput((_input, key) => {
    if (focused && key.tab) {
      setExpanded(v => !v)
    }
  })

  if (!thinking && !isStreaming) return null

  const spinner = isStreaming ? (elapsed % 2000 < 1000 ? '⠋' : '⠙') : ''
  const statusLabel = thinkingStatusLabel({ isStreaming, elapsedMs: elapsed, completedDurationMs, stale })

  return (
    <Box flexDirection="column" paddingX={2}>
      <Text dimColor>
        {expanded ? '▾' : '▸'} {spinner} Thinking{isStreaming ? ` ${statusLabel}` : ` ${statusLabel}`}
        {thinking ? ` (${formatThinkingSize(thinking.length)})` : ''}
        {' '}(Tab to {expanded ? 'collapse' : 'expand'})
      </Text>
      {expanded && (
        <Box paddingLeft={2} borderStyle="single" borderColor="gray">
          <Text dimColor>{truncateThinking(thinking)}</Text>
        </Box>
      )}
    </Box>
  )
}

