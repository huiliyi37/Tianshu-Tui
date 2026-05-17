import chalk from 'chalk'

export interface RivetTheme {
  primary: string
  secondary: string
  success: string
  warning: string
  error: string
  dim: string
  userColor: string
  assistantColor: string
  systemColor: string
  toolColor: (toolName: string) => string
  contextColor: (pct: number) => string
}

export type ThemeName = 'pastel' | 'cyberpunk'

interface ColorSet {
  primary: string
  secondary: string
  success: string
  warning: string
  error: string
  dim: string
}

// Pastel theme — soft, pleasant, 二次元-inspired (default)
// Based on Soft UI Evolution: improved contrast pastels on dark terminal background
const PASTEL_TRUECOLOR: ColorSet = {
  primary: '#a8e6cf',   // mint green — search/grep/glob
  secondary: '#d4a5f5', // lavender — edit/write
  success: '#b5ead7',   // soft green — tests pass
  warning: '#ffdac1',   // warm peach — delegation/warnings
  error: '#ff9aa2',     // coral pink — errors
  dim: '#8585a0',       // soft gray — secondary info
}

const PASTEL_FALLBACK: ColorSet = {
  primary: 'cyan',
  secondary: 'magenta',
  success: 'green',
  warning: 'yellow',
  error: 'red',
  dim: 'gray',
}

// Cyberpunk theme — high-saturation neon (legacy, switchable)
const CYBERPUNK_TRUECOLOR: ColorSet = {
  primary: '#00ffcc',
  secondary: '#7b2fff',
  success: '#00ff88',
  warning: '#ffaa00',
  error: '#ff3333',
  dim: '#4a4a6a',
}

const CYBERPUNK_FALLBACK: ColorSet = {
  primary: 'cyan',
  secondary: 'magenta',
  success: 'green',
  warning: 'yellow',
  error: 'red',
  dim: 'gray',
}

function makeToolColor(c: ColorSet) {
  return (name: string): string => {
    switch (name) {
      case 'bash': case 'grep': case 'glob': return c.primary
      case 'edit_file': case 'write_file': return c.secondary
      case 'run_tests': return c.success
      case 'delegate_task': case 'delegate_batch': return c.warning
      default: return c.dim
    }
  }
}

function makeContextColor(c: Pick<ColorSet, 'primary' | 'warning' | 'error'>) {
  return (pct: number): string => {
    if (pct >= 0.8) return c.error
    if (pct >= 0.6) return c.warning
    return c.primary
  }
}

function buildTheme(colors: ColorSet): RivetTheme {
  return {
    ...colors,
    userColor: colors.primary,       // mint green
    assistantColor: colors.secondary, // lavender
    systemColor: colors.dim,          // dim gray
    toolColor: makeToolColor(colors),
    contextColor: makeContextColor(colors),
  }
}

const THEMES: Record<ThemeName, { truecolor: RivetTheme; fallback: RivetTheme }> = {
  pastel: {
    truecolor: buildTheme(PASTEL_TRUECOLOR),
    fallback: buildTheme(PASTEL_FALLBACK),
  },
  cyberpunk: {
    truecolor: buildTheme(CYBERPUNK_TRUECOLOR),
    fallback: buildTheme(CYBERPUNK_FALLBACK),
  },
}

let activeTheme: ThemeName = 'pastel'

export function setTheme(name: ThemeName): void {
  activeTheme = name
}

export function getActiveThemeName(): ThemeName {
  return activeTheme
}

export function getTheme(colorLevel?: number): RivetTheme {
  const level = colorLevel ?? chalk.level
  const theme = THEMES[activeTheme]
  return level >= 3 ? theme.truecolor : theme.fallback
}
