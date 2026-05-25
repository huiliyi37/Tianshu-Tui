import { Box, Text } from 'ink'
import { memo } from 'react'
import { getTheme } from './theme.js'
import { formatElapsed } from './format-utils.js'
import { PHASE_LABELS, PHASE_GLYPHS } from '../agent/star-event.js'
import type { PhaseSegment } from '../agent/chronicle.js'

export interface ChronicleViewProps {
  segments: PhaseSegment[]
  elapsedMs: number
}

export const ChronicleView = memo(function ChronicleView({ segments, elapsedMs }: ChronicleViewProps) {
  const theme = getTheme()

  return (
    <Box flexDirection="column" paddingX={2} paddingY={1}>
      <Box justifyContent="center">
        <Text bold color={theme.primary}>╭── 星辰编年史 ──╮</Text>
      </Box>

      <Box height={1} />

      {segments.length === 0 && (
        <Text dimColor>暂无记录。agent 执行中…</Text>
      )}

      {segments.map((seg, i) => {
        const glyph = PHASE_GLYPHS[seg.phase] ?? '?'
        const label = PHASE_LABELS[seg.phase] ?? seg.phase
        const duration = seg.endTimestamp
          ? formatElapsed(seg.endTimestamp - seg.startTimestamp)
          : '进行中…'

        return (
          <Box key={i} flexDirection="column" marginBottom={1}>
            <Text>
              <Text bold>{glyph} {label}</Text>
              <Text dimColor> (T{seg.startTurn}{seg.endTurn !== undefined ? `─${seg.endTurn}` : '+'} │ {duration})</Text>
            </Text>
            {seg.entries.map((entry, j) => (
              <Box key={j} paddingLeft={2}>
                <Text color={entry.type === 'milestone' ? theme.warning : 'cyan'} dimColor>
                  {entry.summary}
                </Text>
              </Box>
            ))}
            {seg.entries.some(e => e.files && e.files.length > 0) && (
              <Box paddingLeft={2}>
                <Text dimColor>
                  📁 {[...new Set(seg.entries.flatMap(e => e.files ?? []))].join(', ')}
                </Text>
              </Box>
            )}
          </Box>
        )
      })}

      <Box height={1} />
      <Text dimColor>总用时: {formatElapsed(elapsedMs)} │ 按 1 返回对话 │ 按 2 星图 │ 按 4 驾驶舱</Text>
    </Box>
  )
})
