import { Box, Text } from 'ink'
import { memo } from 'react'
import { getTheme } from './theme.js'
import type { Sensorium } from '../agent/sensorium.js'
import type { StarPhase, StarEvent } from '../agent/star-event.js'

// ─── Props ──────────────────────────────────────────────────────────

export interface StarStatusProps {
  /** Current StarEvent, or null if no phase emitted yet */
  event: StarEvent | null
  /** Current Sensorium, or null */
  sensorium: Sensorium | null
}

// ─── Sensorium Mini Bar ─────────────────────────────────────────────

const DIM_NAMES: (keyof Sensorium)[] = [
  'momentum', 'pressure', 'confidence',
  'complexity', 'freshness', 'stability',
]

const DIM_LABELS: Record<keyof Sensorium, string> = {
  momentum: '冲',
  pressure: '压',
  confidence: '信',
  complexity: '杂',
  freshness: '鲜',
  stability: '稳',
}

function sensoriumSpark(s: Sensorium): string {
  return DIM_NAMES.map(dim => {
    const v = s[dim]
    const label = DIM_LABELS[dim]
    // Braille spark: ▁▂▃▄▅▆▇█ based on value 0-1
    const level = Math.round(v * 7)
    const chars = ['▁', '▂', '▃', '▄', '▅', '▆', '▇', '█']
    return `${label}${chars[level]}`
  }).join(' ')
}

function phaseStatusLine(phase: StarPhase): string {
  switch (phase) {
    case 'tianshu-planning':   return '天枢授策'
    case 'tianxuan-locating':  return '紫微寻迹'
    case 'tianji-decomposing': return '天玑排阵'
    case 'tianquan-contracting': return '天权立约'
    case 'yuheng-implementing': return '玉衡铸形'
    case 'kaiyang-testing':    return '开阳试锋'
    case 'yaoguang-delivering': return '摇光归航'
    case 'tianshu-encore':     return '天枢再临'
  }
}

// ─── Component ──────────────────────────────────────────────────────

/**
 * Compact TUI component showing the current star phase +
 * 6-dimension sensorium sparkline.
 *
 * Renders as a single row:
 *   ⭐ 天枢授策 │ 冲▆ 压▃ 信▇ 杂▂ 鲜▄ 稳▇
 */
export const StarStatus = memo(function StarStatus({ event, sensorium }: StarStatusProps) {
  if (!event && !sensorium) return null

  const theme = getTheme()
  const phase = event?.phase ?? 'tianshu-planning'
  const glyph = event?.glyph ?? '⭐'
  const label = event ? phaseStatusLine(phase) : '…'

  return (
    <Box flexDirection="row" paddingX={1} justifyContent="space-between">
      <Box gap={1}>
        <Text bold color={theme.primary}>{glyph}</Text>
        <Text color={theme.primary}>{label}</Text>
      </Box>
      {sensorium && (
        <Text dimColor>{sensoriumSpark(sensorium)}</Text>
      )}
    </Box>
  )
})
