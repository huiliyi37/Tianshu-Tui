import { Box, Text } from 'ink'
import { memo, useMemo } from 'react'
import { getTheme } from './theme.js'

interface DiffRenderProps {
  text: string
  maxLines?: number
}

export function isDiffContent(text: string): boolean {
  let diffSignals = 0
  let hasHunk = false
  const lines = text.split('\n')
  for (const line of lines.slice(0, 20)) {
    if (!line) continue
    if (/^diff --git/.test(line)) { diffSignals += 2; continue }
    if (/^(---|\+\+\+)\s/.test(line)) { diffSignals++; continue }
    if (/^@@[^@]+@@/.test(line)) { hasHunk = true; diffSignals++; continue }
  }
  if (hasHunk && /^[-+]/m.test(text)) return true
  return diffSignals >= 2
}

function classifyLine(line: string): 'add' | 'del' | 'hunk' | 'header' | 'meta' | 'context' | 'no-newline' {
  if (/^diff --git/.test(line)) return 'meta'
  if (/^index\s/.test(line)) return 'meta'
  if (/^(---|\+\+\+)\s/.test(line)) return 'header'
  if (/^@@[^@]+@@/.test(line)) return 'hunk'
  if (/^\+/.test(line)) return 'add'
  if (/^-/.test(line)) return 'del'
  if (/^\\ No newline/.test(line)) return 'no-newline'
  return 'context'
}

function diffStats(text: string): { added: number; removed: number } {
  let added = 0
  let removed = 0
  for (const line of text.split('\n')) {
    if (/^\+[^+]/.test(line)) added++
    else if (/^-[^-]/.test(line)) removed++
  }
  return { added, removed }
}

function trimHunkLabel(line: string): string {
  const m = line.match(/^@@[^@]+@@\s*(.*)/)
  return m ? `@@ ${m[1]}` : line
}

export const DiffRender = memo(function DiffRender({ text, maxLines = 50 }: DiffRenderProps) {
  const theme = getTheme()
  const lines = useMemo(() => text.split('\n'), [text])
  const stats = useMemo(() => diffStats(text), [text])
  const { visibleLines, truncated } = useMemo(() => {
    if (lines.length <= maxLines) return { visibleLines: lines, truncated: 0 }
    const half = Math.floor(maxLines / 2)
    return {
      visibleLines: [...lines.slice(0, half), `... ${lines.length - maxLines} lines hidden ...`, ...lines.slice(-half)],
      truncated: lines.length - maxLines,
    }
  }, [lines, maxLines])

  return (
    <Box flexDirection="column">
      <Text bold color={theme.primary}>
        ── diff ({stats.added}<Text color="green">+</Text> {stats.removed}<Text color="red">-</Text>) ──
        {truncated > 0 && <Text color={theme.muted}> {truncated} lines hidden</Text>}
      </Text>
      {visibleLines.map((line, i) => {
        const kind = classifyLine(line)
        switch (kind) {
          case 'add':
            return <Text key={i} color="green">{line}</Text>
          case 'del':
            return <Text key={i} color="red">{line}</Text>
          case 'hunk':
            return <Text key={i} color={theme.muted}>{trimHunkLabel(line)}</Text>
          case 'header':
            return <Text key={i} color={theme.warning}>{line}</Text>
          case 'meta':
            return <Text key={i} color={theme.muted}>{line}</Text>
          case 'no-newline':
            return <Text key={i} color={theme.muted}>{line}</Text>
          default:
            return <Text key={i} color={theme.muted}>{line}</Text>
        }
      })}
    </Box>
  )
})
