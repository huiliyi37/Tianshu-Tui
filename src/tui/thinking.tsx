import { useState, useEffect, useRef } from 'react'
import { Box, Text, useInput } from 'ink'
import { getTheme } from './theme.js'
import { circleSpinnerFrame } from './braille-spinner.js'
import { gutterGlyph } from './gutter.js'

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
  // Detect within-response thinking loops and trim to a single copy.
  const lines = text.split('\n')
  if (lines.length < 6) return { text, trimmed: 0 }

  // Strategy 1: single non-blank line repeating 5+ times
  const freq = new Map<string, number>()
  for (const line of lines) {
    const trimmed = line.trim()
    if (trimmed.length < 20) continue
    freq.set(trimmed, (freq.get(trimmed) ?? 0) + 1)
  }
  for (const [l, count] of freq) {
    if (count >= 5) {
      const needle = lines.find(l2 => l2.trim() === l) ?? l
      const idx = text.indexOf(needle)
      if (idx >= 0) {
        const end = idx + needle.length
        const trimmed = text.length - end
        return { text: text.slice(0, end) + `\n... (${trimmed} repetitive characters trimmed)`, trimmed }
      }
    }
  }

  // Strategy 2: 4-line segment repeating 2+ times
  const mid = Math.floor(lines.length / 2)
  const segmentCandidates = [
    lines.slice(1, Math.min(5, lines.length)).join('\n'),        // near start
    lines.slice(mid, Math.min(mid + 4, lines.length)).join('\n'), // middle
    lines.slice(-5, -1).join('\n'),                               // near end
  ]

  for (const c of segmentCandidates) {
    if (c.length < 40) continue
    const count = text.split(c).length - 1
    if (count >= 2) {
      const idx = text.indexOf(c)
      if (idx >= 0) {
        const end = idx + c.length
        const trimmed = text.length - end
        return { text: text.slice(0, end) + `\n... (${trimmed} repetitive characters trimmed)`, trimmed }
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
  const [frame, setFrame] = useState(0)
  const [stale, setStale] = useState(false)
  const startRef = useRef(0)
  const elapsedRef = useRef(0)
  const thinkingRef = useRef(thinking)
  const staleCheckRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  useEffect(() => {
    if (isStreaming && thinking && startRef.current === 0) {
      startRef.current = Date.now()
      setElapsed(0)
      elapsedRef.current = 0
      // Don't auto-expand during streaming — keep compact status line
      // to prevent layout instability and scroll jumping.
      // User can Tab to expand manually.
    }
    if (!isStreaming) {
      startRef.current = 0
      setStale(false)
      setExpanded(false)
    }
    if (!focused && expanded) {
      setExpanded(false)
    }
  }, [isStreaming, thinking, focused])

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
      setFrame(f => f + 1)
      if (startRef.current > 0) {
        const newElapsed = Date.now() - startRef.current
        if (Math.floor(newElapsed / 1000) !== Math.floor(elapsedRef.current / 1000)) {
          elapsedRef.current = newElapsed
          setElapsed(newElapsed)
        }
      }
    }, 120)
    return () => clearInterval(id)
  }, [isStreaming])

  useInput((_input, key) => {
    if (focused && key.tab) {
      setExpanded(v => !v)
    }
  })

  if (!isStreaming) return null

  const spinner = circleSpinnerFrame(frame)
  const statusLabel = thinkingStatusLabel({ isStreaming, elapsedMs: elapsed, completedDurationMs, stale })
  const theme = getTheme()

  // Minimal indicator: thinking has started but no content flushed yet
  // (first chunk is delayed 200ms to avoid layout突变)
  if (!thinking) {
    return (
      <Box flexDirection="column" paddingX={2}>
        <Text color={theme.dim}>
          {gutterGlyph('thinking')} {spinner} <Text italic>Thinking</Text>...
        </Text>
      </Box>
    )
  }

  if (!expanded) {
    return (
      <Box flexDirection="column" paddingX={2}>
        <Text color={theme.dim}>
          {gutterGlyph('thinking')} {spinner} <Text italic>Thinking</Text> {statusLabel}
          {` (${formatThinkingSize(thinking.length)})`}
          {focused ? ' (Tab to expand)' : ''}
        </Text>
      </Box>
    )
  }

  const MAX_VISIBLE_LINES = 8
  const thinkingLines = truncateThinking(thinking).split('\n')
  const visibleThinking = thinkingLines.length > MAX_VISIBLE_LINES
    ? [`... ${thinkingLines.length - MAX_VISIBLE_LINES} earlier lines`, ...thinkingLines.slice(-MAX_VISIBLE_LINES)].join('\n')
    : thinkingLines.join('\n')

  return (
    <Box flexDirection="column" paddingX={2}>
      <Text color={theme.dim}>
        {gutterGlyph('thinking')} {spinner} <Text italic>Thinking</Text> {statusLabel}
        {` (${formatThinkingSize(thinking.length)})`}
        {focused ? ' (Tab to collapse)' : ''}
      </Text>
      <Box paddingLeft={2}>
        <Text color={theme.muted}>{visibleThinking}</Text>
      </Box>
    </Box>
  )
}

