import { Box, Text } from 'ink'
import { memo } from 'react'
import { type Panel, PANELS, PANEL_LABELS, type PanelStatus } from './types.js'
import { getTheme } from '../theme.js'

export interface CockpitRailProps {
  activePanel: Panel
  panelStatuses: Record<Panel, PanelStatus>
  onSelect: (panel: Panel) => void
}

function statusIndicator(status: PanelStatus): string {
  if (status === 'error') return '●'
  if (status === 'warn') return '◐'
  return ''
}

function statusColor(status: PanelStatus, theme: ReturnType<typeof getTheme>): string {
  if (status === 'error') return theme.error
  if (status === 'warn') return theme.warning
  return theme.dim
}

export const CockpitRail = memo(function CockpitRail({ activePanel, panelStatuses }: CockpitRailProps) {
  const theme = getTheme()

  return (
    <Box gap={1}>
      {PANELS.map(panel => {
        const active = panel === activePanel
        const status = panelStatuses[panel]
        const indicator = statusIndicator(status)
        return (
          <Text
            key={panel}
            color={active ? theme.primary : theme.dim}
            bold={active}
          >
            {indicator && <Text color={statusColor(status, theme)}>{indicator}</Text>}
            {active ? `[${PANEL_LABELS[panel]}]` : ` ${PANEL_LABELS[panel]} `}
          </Text>
        )
      })}
    </Box>
  )
})
