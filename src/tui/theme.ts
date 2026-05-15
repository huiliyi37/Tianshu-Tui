import chalk from 'chalk'

export interface RivetTheme {
  primary: string
  secondary: string
  success: string
  warning: string
  error: string
  dim: string
  toolColor: (toolName: string) => string
  contextColor: (pct: number) => string
}

const TRUECOLOR_COLORS = {
  primary: '#00ffcc',
  secondary: '#7b2fff',
  success: '#00ff88',
  warning: '#ffaa00',
  error: '#ff3333',
  dim: '#4a4a6a',
}

const FALLBACK_COLORS = {
  primary: 'cyan',
  secondary: 'magenta',
  success: 'green',
  warning: 'yellow',
  error: 'red',
  dim: 'gray',
}

function makeToolColor(c: typeof TRUECOLOR_COLORS) {
  return (name: string): string => {
    switch (name) {
      case 'bash': case 'grep': case 'glob': return c.primary
      case 'edit_file': case 'write_file': return c.secondary
      case 'run_tests': return c.success
      case 'delegate_task': return c.warning
      default: return c.dim
    }
  }
}

function makeContextColor(c: Pick<typeof TRUECOLOR_COLORS, 'primary' | 'warning' | 'error'>) {
  return (pct: number): string => {
    if (pct >= 0.8) return c.error
    if (pct >= 0.6) return c.warning
    return c.primary
  }
}

const TRUECOLOR: RivetTheme = {
  ...TRUECOLOR_COLORS,
  toolColor: makeToolColor(TRUECOLOR_COLORS),
  contextColor: makeContextColor(TRUECOLOR_COLORS),
}

const FALLBACK: RivetTheme = {
  ...FALLBACK_COLORS,
  toolColor: makeToolColor(FALLBACK_COLORS),
  contextColor: makeContextColor(FALLBACK_COLORS),
}

export function getTheme(colorLevel?: number): RivetTheme {
  const level = colorLevel ?? chalk.level
  return level >= 3 ? TRUECOLOR : FALLBACK
}
