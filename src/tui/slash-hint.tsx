import { Box, Text } from 'ink'
import { useMemo } from 'react'
import { getTheme } from './theme.js'
import { type PaletteCommand, filterCommands } from './command-palette.js'

interface SlashHintProps {
  input: string
  selectedIdx: number
  commands: PaletteCommand[]
}

/** Maximum number of items to render before the "more…" footer. */
export const SLASH_HINT_MAX_VISIBLE = 6

/**
 * Rows the palette consumes BESIDES its command list: round border (top+bottom
 * = 2), "◇ Command Palette" header (1) + its marginBottom (1), and the "… N
 * more" footer + its marginTop (2 when overflowing). Plus the ground zone the
 * palette sits above (GlanceBar + bordered InputBar + margin ≈ 7). We keep the
 * palette + ground STRICTLY under the viewport so the live region never reaches
 * terminal height — otherwise Ink's fullscreen re-emit (`lastOutputHeight >=
 * rows`) freezes a palette snapshot into scrollback as a permanent ghost box.
 * See [[resize-ghost-streaming-timer-bypass]] (root cause five).
 */
const PALETTE_NON_LIST_ROWS = 6 // border 2 + header 1 + headerMargin 1 + footer 1 + footerMargin 1
const GROUND_ROWS = 7

/** How many command rows fit without pushing the live region to terminal height. */
export function slashHintMaxVisible(terminalRows: number): number {
  const budget = terminalRows - GROUND_ROWS - PALETTE_NON_LIST_ROWS - 1 // -1 safety margin
  if (budget < 1) return 1 // always show at least the selected command
  return Math.min(SLASH_HINT_MAX_VISIBLE, budget)
}

export function SlashHint({ input, selectedIdx, commands }: SlashHintProps) {
  const theme = getTheme()
  const query = input.slice(1) // strip leading /
  const filtered = useMemo(() => filterCommands(commands, query), [commands, query])

  if (filtered.length === 0) return null

  const maxVisible = slashHintMaxVisible(process.stdout.rows ?? 24)
  const visible = filtered.slice(0, maxVisible)
  const overflow = filtered.length - visible.length

  return (
    <Box
      flexDirection="column"
      borderStyle="round"
      borderColor={theme.primary}
      paddingX={1}
      marginX={1}
    >
      <Box marginBottom={1}>
        <Text color={theme.dim}>◇ Command Palette</Text>
      </Box>
      {visible.map((cmd, i) => {
        const selected = i === selectedIdx
        return (
          <Box key={cmd.name}>
            <Text color={selected ? theme.primary : theme.dim}>
              {selected ? '❯ ' : '  '}
            </Text>
            <Text bold={selected} color={selected ? theme.primary : theme.secondary}>
              {highlightMatch(cmd.name, query)}
            </Text>
            <Text color={theme.muted}> — {cmd.description}</Text>
          </Box>
        )
      })}
      {overflow > 0 && (
        <Box marginTop={1}>
          <Text color={theme.dim}>… {overflow} more</Text>
        </Box>
      )}
    </Box>
  )
}

function highlightMatch(name: string, query: string): string {
  if (!query) return name
  return name
}
