import { Box, Text } from 'ink'
import { memo } from 'react'
import { type Panel, PANELS, PANEL_LABELS } from './types.js'
import { getTheme } from '../theme.js'

export interface CockpitRailProps {
  activePanel: Panel
  onSelect: (panel: Panel) => void
}

export const CockpitRail = memo(function CockpitRail({ activePanel, onSelect }: CockpitRailProps) {
  const theme = getTheme()

  return (
    <Box gap={1}>
      {PANELS.map(panel => (
        <Text
          key={panel}
          color={panel === activePanel ? theme.primary : theme.dim}
          bold={panel === activePanel}
        >
          {panel === activePanel ? `[${PANEL_LABELS[panel]}]` : ` ${PANEL_LABELS[panel]} `}
        </Text>
      ))}
    </Box>
  )
})
