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

export type ThemeName = 'pastel' | 'cyberpunk' | 'observatory' | 'midnight'

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

// Cyberpunk theme — high-saturation neon (legacy, switchable)
const CYBERPUNK_TRUECOLOR: ColorSet = {
  primary: '#00ffcc',
  secondary: '#7b2fff',
  success: '#00ff88',
  warning: '#ffaa00',
  error: '#ff3333',
  dim: '#4a4a6a',
  pulseQuiet: '#2f3048',
  pulseActive: '#00ffcc',
  pulseAlert: '#ff3333',
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

function buildTheme(colors: ColorSet, overrides?: { userColor?: string; assistantColor?: string }): RivetTheme {
  return {
    ...colors,
    muted: '#9aa2b1',
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
