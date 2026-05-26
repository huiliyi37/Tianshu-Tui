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
  const [stale, setStale] = useState(false)
  const startRef = useRef(0)
  const thinkingRef = useRef(thinking)
  const staleCheckRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  useEffect(() => {
    if (isStreaming && thinking && startRef.current === 0) {
      startRef.current = Date.now()
      setElapsed(0)
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
      if (startRef.current > 0) {
        setElapsed(Date.now() - startRef.current)
      }
    }, 2000)
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

  // During streaming: compact single-line status to prevent layout instability.
  // Only expand on explicit Tab toggle (focused && key.tab).
  // After streaming: show collapsed preview of last few lines.
  if (isStreaming && !expanded) {
    return (
      <Box flexDirection="column" paddingX={2}>
        <Text dimColor>
          {'▸'} {spinner} Thinking {statusLabel}
          {thinking ? ` (${formatThinkingSize(thinking.length)})` : ''}
          {focused ? ' (Tab to expand)' : ''}
        </Text>
      </Box>
    )
  }

  const MAX_VISIBLE_LINES = 8
  const COLLAPSED_PREVIEW_LINES = 3
  const thinkingLines = truncateThinking(thinking).split('\n')
  const visibleThinking = thinkingLines.length > MAX_VISIBLE_LINES
    ? [...thinkingLines.slice(-MAX_VISIBLE_LINES), `... ${thinkingLines.length - MAX_VISIBLE_LINES} earlier lines`].join('\n')
    : thinkingLines.join('\n')

  // Collapsed preview: show last N lines so user can see recent thinking without expanding
  const previewLines = thinkingLines.slice(-COLLAPSED_PREVIEW_LINES)
  const previewOmitted = Math.max(0, thinkingLines.length - COLLAPSED_PREVIEW_LINES)

  return (
    <Box flexDirection="column" paddingX={thinking ? 2 : 1}>
      <Text dimColor>
        {expanded ? '▾' : '▸'} {spinner} Thinking{isStreaming ? ` ${statusLabel}` : ` ${statusLabel}`}
        {thinking ? ` (${formatThinkingSize(thinking.length)})` : ''}
        {focused ? ` (Tab to ${expanded ? 'collapse' : 'expand'})` : ''}
      </Text>
      {expanded ? (
        <Box paddingLeft={2} borderStyle="single" borderColor="gray">
          <Text dimColor>{visibleThinking}</Text>
        </Box>
      ) : (
        previewLines.length > 0 && (
          <Box paddingLeft={2} flexDirection="column">
            {previewOmitted > 0 && (
              <Text dimColor>  ... {previewOmitted} earlier lines</Text>
            )}
            {previewLines.map((line, i) => (
              <Text key={i} dimColor>  {line}</Text>
            ))}
          </Box>
        )
      )}
    </Box>
  )
}

