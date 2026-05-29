import { Box, Text } from 'ink'
import { memo } from 'react'
import { renderStarmapConstellation } from './starmap-constellation.js'
import { alchemyBar, alchemyStage, ALCHEMY_COLORS } from './alchemy-bar.js'
import { formatElapsed } from './format-utils.js'
import { getTheme } from './theme.js'
import type { StarPhase } from '../agent/star-event.js'
import type { ChronicleEntry } from '../agent/chronicle.js'

// ─── Props ───────────────────────────────────────────────────────────

export interface StarmapViewProps {
  activePhase: StarPhase
  sensorium?: {
    momentum: number
    pressure: number
    confidence: number
    complexity: number
    freshness: number
    stability: number
  }
  turnCount: number
  maxTurns: number
  elapsedMs: number
  recentRadio: readonly ChronicleEntry[]
}

// ─── Gauge Helper ────────────────────────────────────────────────────

function gauge(label: string, value: number, width = 8): string {
  const filled = Math.round(Math.max(0, Math.min(1, value)) * width)
  return `${label} ${'⣿'.repeat(filled)}${'⣀'.repeat(width - filled)}`
}

// ─── StarmapView ─────────────────────────────────────────────────────

export const StarmapView = memo(function StarmapView(props: StarmapViewProps) {
  const { activePhase, sensorium, turnCount, maxTurns, elapsedMs, recentRadio } = props
  const theme = getTheme()
  const constellationLines = renderStarmapConstellation(activePhase)
  const confidence = sensorium?.confidence ?? 0
  const alchemyColor = ALCHEMY_COLORS[alchemyStage(confidence)]

  return (
    <Box flexDirection="column" paddingX={1}>
      {/* 1. Title */}
      <Box justifyContent="center">
        <Text bold color={theme.primary}>╭── 紫微星桥 ──╮</Text>
      </Box>

      {/* 2. Blank */}
      <Text>{' '}</Text>

      {/* 3. Constellation */}
      <Box flexDirection="column">
        {constellationLines.map((line, i) => (
          <Text key={i}>{line}</Text>
        ))}
      </Box>

      {/* 4. Blank */}
      <Text>{' '}</Text>

      {/* 5. Sensorium gauges */}
      {sensorium && (
        <>
          <Box gap={4}>
            <Text>{gauge('动力', sensorium.momentum)}</Text>
            <Text>{gauge('信心', sensorium.confidence)}</Text>
          </Box>
          <Box gap={4}>
            <Text>{gauge('压力', sensorium.pressure)}</Text>
            <Text>{gauge('复杂', sensorium.complexity)}</Text>
          </Box>
          <Box gap={4}>
            <Text>{gauge('新鲜', sensorium.freshness)}</Text>
            <Text>{gauge('稳定', sensorium.stability)}</Text>
          </Box>
          <Text>{' '}</Text>
        </>
      )}

      {/* 7. Status line */}
      <Box gap={1}>
        <Text color={alchemyColor} bold={confidence >= 0.8}>
          {alchemyBar(confidence)}
        </Text>
        <Text color={theme.dim}> {String.fromCodePoint(0x2502)} T{turnCount}/{maxTurns} {String.fromCodePoint(0x2502)} {formatElapsed(elapsedMs)}</Text>
      </Box>

      {/* 8. Blank */}
      <Text>{' '}</Text>

      {/* 9. Recent radio messages */}
      {recentRadio.length > 0 && (
        <Box flexDirection="column">
          {recentRadio.map((entry, i) => (
            <Text key={i} color={theme.muted}>
              {'  '}{entry.summary}
            </Text>
          ))}
        </Box>
      )}

      {/* 10. Blank */}
      <Text>{' '}</Text>

      {/* 11. Help */}
      <Text color={theme.muted}>{'  '}按 1 返回对话 {String.fromCodePoint(0x2502)} 按 3 传说 {String.fromCodePoint(0x2502)} 按 4 驾驶舱</Text>
    </Box>
  )
})
