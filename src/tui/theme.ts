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

function makeToolColorMap(self: { primary: string; secondary: string; success: string; warning: string; dim: string }) {
  return (name: string): string => {
    switch (name) {
      case 'bash': case 'grep': case 'glob': return self.primary
      case 'edit_file': case 'write_file': return self.secondary
      case 'run_tests': return self.success
      case 'delegate_task': return self.warning
      default: return self.dim
    }
  }
}

function makeContextColor(self: { primary: string; warning: string; error: string }) {
  return (pct: number): string => {
    if (pct >= 0.8) return self.error
    if (pct >= 0.6) return self.warning
    return self.primary
  }
}

const TRUECOLOR: RivetTheme = {
  primary: '#00ffcc',
  secondary: '#7b2fff',
  success: '#00ff88',
  warning: '#ffaa00',
  error: '#ff3333',
  dim: '#4a4a6a',
  toolColor: makeToolColorMap({ primary: '#00ffcc', secondary: '#7b2fff', success: '#00ff88', warning: '#ffaa00', dim: '#4a4a6a' }),
  contextColor: makeContextColor({ primary: '#00ffcc', warning: '#ffaa00', error: '#ff3333' }),
}

const FALLBACK: RivetTheme = {
  primary: 'cyan',
  secondary: 'magenta',
  success: 'green',
  warning: 'yellow',
  error: 'red',
  dim: 'gray',
  toolColor: makeToolColorMap({ primary: 'cyan', secondary: 'magenta', success: 'green', warning: 'yellow', dim: 'gray' }),
  contextColor: makeContextColor({ primary: 'cyan', warning: 'yellow', error: 'red' }),
}

export function getTheme(colorLevel?: number): RivetTheme {
  const level = colorLevel ?? chalk.level
  return level >= 3 ? TRUECOLOR : FALLBACK
}
