import { useState, useEffect, useRef } from 'react'
import { Box, Text, useInput } from 'ink'

interface ThinkingStatusOptions {
  isStreaming: boolean
  elapsedMs: number
  completedDurationMs?: number
  stale?: boolean
}

export function thinkingStatusLabel(options: ThinkingStatusOptions): string {
  if (!options.isStreaming) {
    if (options.completedDurationMs !== undefined) return `completed in ${formatDuration(options.completedDurationMs)}`
    return 'completed'
  }
  // Tiered messages based on elapsed time while streaming
  const sec = Math.round(options.elapsedMs / 1000)
  const min = Math.round(options.elapsedMs / 60_000)
  if (options.elapsedMs >= 180_000) return `Long think — Ctrl+C to stop (${min}m)`
  if (options.elapsedMs >= 90_000) return `Still thinking... ${formatDuration(options.elapsedMs)}`
  if (options.elapsedMs >= 30_000) return `Collecting context... ${sec}s`
  return formatDuration(options.elapsedMs)
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

function detectRepetition(text: string): { text: string; trimmed: number } {
  // Detect if a ~100-char paragraph repeats 3+ times in the thinking content.
  // This catches within-response thinking loops and trims the repetitive tail.
  const lines = text.split('\n')
  if (lines.length < 6) return { text, trimmed: 0 }

  // Sample 3 evenly-spaced paragraphs and check for repeats
  const mid = Math.floor(lines.length / 2)
  const candidates = [
    lines.slice(1, Math.min(5, lines.length)).join('\n'),        // near start
    lines.slice(mid, Math.min(mid + 3, lines.length)).join('\n'), // middle
    lines.slice(-4, -1).join('\n'),                               // near end
  ]

  for (const c of candidates) {
    if (c.length < 40) continue
    const count = text.split(c).length - 1
    if (count >= 3) {
      // Find the first occurrence and truncate after the second repeat
      let idx = text.indexOf(c)
      idx = text.indexOf(c, idx + c.length)
      idx = text.indexOf(c, idx + c.length)
      if (idx > 0) {
        const trimmed = text.length - idx
        return { text: text.slice(0, idx) + `\n... (${trimmed} repetitive characters trimmed)`, trimmed }
      }
    }
  }
  return { text, trimmed: 0 }
}

function truncateThinking(text: string): string {
  // First compress repetitive patterns, then enforce size limit
  const deduped = detectRepetition(text)
  let result = deduped.text
  if (result.length > MAX_THINKING_DISPLAY) {
    result = result.slice(0, MAX_THINKING_DISPLAY) + `\n... (${result.length - MAX_THINKING_DISPLAY} more characters)`
  }
  return result
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
      }, 30_000)
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

