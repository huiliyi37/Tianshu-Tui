import chalk from 'chalk'

export interface RivetTheme {
  primary: string
  secondary: string
  success: string
  warning: string
  error: string
  dim: string
  muted: string
  pulseQuiet: string
  pulseActive: string
  pulseAlert: string
  userColor: string
  assistantColor: string
  systemColor: string
  toolColor: (toolName: string) => string
  contextColor: (pct: number) => string
}

export type ThemeName = 'pastel' | 'cyberpunk' | 'observatory' | 'midnight' | 'starfield'

interface ColorSet {
  primary: string
  secondary: string
  success: string
  warning: string
  error: string
  dim: string
  pulseQuiet: string
  pulseActive: string
  pulseAlert: string
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
  pulseQuiet: '#4a4a5a', // dim violet gray — dark cockpit quiet
  pulseActive: '#a8e6cf', // mint green — active pulse
  pulseAlert: '#ff9aa2',  // coral pink — alert pulse
}

const PASTEL_FALLBACK: ColorSet = {
  primary: 'cyan',
  secondary: 'magenta',
  success: 'green',
  warning: 'yellow',
  error: 'red',
  dim: 'gray',
  pulseQuiet: 'gray',
  pulseActive: 'cyan',
  pulseAlert: 'red',
}

// Cyberpunk theme — neon tech-noir, tuned for legibility on near-black bg.
// Original maxed-out neons (#00ffcc/#7b2fff/#00ff88/#ff3333) had two defects on
// dark terminals: (1) the electric purple secondary failed WCAG AA (3.3:1) and
// vibrated against black; (2) primary cyan-green and success green were nearly
// the same hue, so they read as one color. Fix per dark-mode color rules: raise
// lightness + ease saturation, split the greens (cyan primary vs green success),
// lift the purple to a readable lavender, swap pure-red for rose to kill halation.
const CYBERPUNK_TRUECOLOR: ColorSet = {
  primary: '#22d3ee',   // cyan-400 — distinct cyan (was #00ffcc, collided w/ success)
  secondary: '#c4a3ff', // lavender — readable violet, 9:1 (was #7b2fff, failed AA 3.3:1)
  success: '#4ade80',   // green-400 — clearly green, separated from primary cyan
  warning: '#fbbf24',   // amber-400 — softer than raw orange, still neon-warm
  error: '#fb7185',     // rose-400 — alarming without pure-red halation on black
  dim: '#6b6b8f',       // raised violet-gray so dividers are actually visible (was 2.5:1)
  pulseQuiet: '#2f3048',
  pulseActive: '#22d3ee',
  pulseAlert: '#fb7185',
}

const CYBERPUNK_FALLBACK: ColorSet = {
  primary: 'cyan',
  secondary: 'magenta',
  success: 'green',
  warning: 'yellow',
  error: 'red',
  dim: 'gray',
  pulseQuiet: 'gray',
  pulseActive: 'cyan',
  pulseAlert: 'red',
}

// Observatory theme — 五色星辰 (Five-Color Star Palette)
// 基于中国传统五色体系，北斗七星在北方 → 水 → 玄色
const OBSERVATORY_TRUECOLOR: ColorSet = {
  primary: '#4f46e5',   // 靛蓝 (indigo) — 天玑星君主色，青出于蓝
  secondary: '#a78bfa', // 星云紫 — 星云/辅助色
  success: '#34d399',   // 验证翠 — 测试通过/归航
  warning: '#f59e0b',   // 星金黄 — 活跃星/炼金高阶
  error: '#f87171',     // 警报珊 — 错误/高风险
  dim: '#64748b',       // 远星灰 — 非活跃/次要信息
  pulseQuiet: '#334155', // 玄灰 — quiet pulse
  pulseActive: '#38bdf8', // 天青 — active pulse
  pulseAlert: '#f87171',  // 警报珊 — alert pulse
}

const OBSERVATORY_FALLBACK: ColorSet = {
  primary: 'blue',
  secondary: 'magenta',
  success: 'green',
  warning: 'yellow',
  error: 'red',
  dim: 'gray',
  pulseQuiet: 'gray',
  pulseActive: 'cyan',
  pulseAlert: 'red',
}

// Midnight theme — GitHub Dark inspired, clear hierarchy, functional color
// Three-layer gray (fg / muted / subtle) + single accent blue + semantic colors
const MIDNIGHT_TRUECOLOR: ColorSet = {
  primary: '#58a6ff',   // accent blue — links, selection, active
  secondary: '#b0b8c4', // medium gray — labels, data values (bumped from #8b949e)
  success: '#3fb950',   // green — pass, active pulse
  warning: '#d29922',   // gold — attention, delegation
  error: '#f85149',     // red — errors, alerts
  dim: '#6e7681',       // subtle gray — separators, decoration only
  pulseQuiet: '#3d4450', // dark border gray — quiet pulse
  pulseActive: '#58a6ff', // accent blue — active pulse
  pulseAlert: '#f85149',  // red — alert pulse
}

const MIDNIGHT_FALLBACK: ColorSet = {
  primary: 'blue',
  secondary: 'white',
  success: 'green',
  warning: 'yellow',
  error: 'red',
  dim: 'gray',
  pulseQuiet: 'gray',
  pulseActive: 'blue',
  pulseAlert: 'red',
}

// Starfield theme — 星空/星座. Rivet's home aesthetic (the Big Dipper star-map).
// Astronomy-semantic palette: every accent is a kind of star/sky phenomenon, all
// tuned bright + slightly desaturated so they glow on deep-space black without the
// vibration of pure neon. All text colors clear WCAG AA (8:1+) on near-black.
const STARFIELD_TRUECOLOR: ColorSet = {
  primary: '#8ab4ff',   // hot blue-white star (Vega/Rigel) — links, search/bash
  secondary: '#c9a9ff', // nebula violet — edit/write, headers
  success: '#7ee7c7',   // aurora teal-green — tests pass, return-home
  warning: '#ffd479',   // stellar gold (Sol/Arcturus) — delegation/attention
  error: '#ff8a9b',     // nova / red-giant flare — errors
  dim: '#6b7394',       // cosmic dust lane — separators, decoration (4:1, visible)
  pulseQuiet: '#2b3052', // deep space blue-gray — quiet pulse
  pulseActive: '#8ab4ff', // star blue — active pulse
  pulseAlert: '#ff8a9b',  // nova red — alert pulse
}

const STARFIELD_FALLBACK: ColorSet = {
  primary: 'blue',
  secondary: 'magenta',
  success: 'cyan',
  warning: 'yellow',
  error: 'red',
  dim: 'gray',
  pulseQuiet: 'gray',
  pulseActive: 'blue',
  pulseAlert: 'red',
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

function buildTheme(colors: ColorSet, overrides?: { userColor?: string; assistantColor?: string; muted?: string }): RivetTheme {
  return {
    ...colors,
    muted: overrides?.muted ?? '#9aa2b1',
    userColor: overrides?.userColor ?? colors.primary,
    assistantColor: overrides?.assistantColor ?? colors.secondary,
    systemColor: '#9aa2b1',
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
  observatory: {
    truecolor: buildTheme(OBSERVATORY_TRUECOLOR),
    fallback: buildTheme(OBSERVATORY_FALLBACK),
  },
  midnight: {
    truecolor: buildTheme(MIDNIGHT_TRUECOLOR, { userColor: '#e6edf3', assistantColor: '#e6edf3' }),
    fallback: buildTheme(MIDNIGHT_FALLBACK, { userColor: 'white', assistantColor: 'white' }),
  },
  starfield: {
    truecolor: buildTheme(STARFIELD_TRUECOLOR, { userColor: '#e8ecf8', assistantColor: '#c9a9ff', muted: '#aab4d4' }),
    fallback: buildTheme(STARFIELD_FALLBACK, { userColor: 'white', assistantColor: 'magenta' }),
  },
}

let activeTheme: ThemeName = 'midnight'

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
