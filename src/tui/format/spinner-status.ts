/**
 * T9 格式化函数 — spinner 状态行（五行动态符号系统）。
 *
 * - phase 动词映射为五行：水·凝思 (thinking)、火·书写 (streaming)、风·运作 (analyzing)、山·候待 (waiting/idle)。
 * - 各状态定制化符号动画帧，而非千篇一律的 braille spinner。
 * - 回合完成/收束态使用林/木 (❧)。
 * - 提供 ASCII fallback 兼容。
 */

import chalk from 'chalk'
import { color } from '../engine/ansi.js'
import type { RivetTheme } from '../theme.js'
import { circleSpinnerFrame } from '../braille-spinner.js'

export type SpinnerPhase = 'idle' | 'thinking' | 'streaming' | 'waiting' | 'analyzing'

const PHASE_LABELS: Record<Exclude<SpinnerPhase, 'idle'>, string> = {
  thinking: '水 · 凝思',
  streaming: '火 · 书写',
  analyzing: '风 · 运作',
  waiting: '山 · 候待',
}

function getSpinnerFrame(phase: SpinnerPhase, tick: number, useAscii: boolean): string {
  if (useAscii) {
    switch (phase) {
      case 'thinking': return ['~', '=', '~', '-'][((tick % 4) + 4) % 4]!
      case 'streaming': return ['*', '+', 'x', '+'][((tick % 4) + 4) % 4]!
      case 'analyzing': return ['>', 'v', '<', '^'][((tick % 4) + 4) % 4]!
      case 'waiting': return '^'
      default: return '.'
    }
  } else {
    switch (phase) {
      case 'thinking': return circleSpinnerFrame(tick) // ['◐', '◓', '◑', '◒']
      case 'streaming': return ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'][((tick % 10) + 10) % 10]!
      case 'analyzing': return ['⛭', '⛮'][((tick % 2) + 2) % 2]!
      case 'waiting': return '▲'
      default: return '·'
    }
  }
}

/** GlanceBar 用的 phase glyph + 标签 — 五行运行态（对齐设计稿）
 *  ◐ 水·凝思  ✦ 火·书写  ⚙ 风·运作  ▲ 山·候待  ❧ 林·归航 */
export function phaseIndicator(phase: SpinnerPhase): { glyph: string; label: string } {
  const useAscii = chalk.level < 3
  if (useAscii) {
    switch (phase) {
      case 'thinking': return { glyph: '~', label: '水 · 凝思' }
      case 'streaming': return { glyph: '*', label: '火 · 书写' }
      case 'analyzing': return { glyph: '>', label: '风 · 运作' }
      case 'waiting': return { glyph: '^', label: '山 · 候待' }
      case 'idle': return { glyph: '.', label: '空闲' }
    }
  } else {
    switch (phase) {
      case 'thinking': return { glyph: '◐', label: '水 · 凝思' }
      case 'streaming': return { glyph: '✦', label: '火 · 书写' }
      case 'analyzing': return { glyph: '⚙', label: '风 · 运作' }
      case 'waiting': return { glyph: '▲', label: '山 · 候待' }
      case 'idle': return { glyph: '·', label: '候待' }
    }
  }
}

export function formatElapsedHuman(ms: number): string {
  const secs = Math.max(0, Math.floor(ms / 1000))
  if (secs < 60) return `${secs}s`
  return `${Math.floor(secs / 60)}m ${secs % 60}s`
}

export interface SpinnerStatusInput {
  tick: number
  phase: SpinnerPhase
  elapsedMs: number
  stalled?: boolean
}

export function formatSpinnerStatus(input: SpinnerStatusInput, theme: RivetTheme): string | null {
  if (input.phase === 'idle') return null
  const useAscii = chalk.level < 3
  const frame = getSpinnerFrame(input.phase, input.tick, useAscii)
  const phaseLabel = PHASE_LABELS[input.phase]
  const text = `${frame} ${phaseLabel}… (${formatElapsedHuman(input.elapsedMs)} · esc to interrupt)`
  return color(text, input.stalled ? theme.warning : theme.muted)
}

export function formatTokenCount(n: number): string {
  if (n < 1000) return `${n}`
  if (n < 1_000_000) return `${(n / 1000).toFixed(1)}k`
  return `${(n / 1_000_000).toFixed(2)}M`
}

export function formatTurnWorkSummary(input: {
  elapsedMs: number
  inputTokens: number
  outputTokens: number
}, theme: RivetTheme): string {
  const useAscii = chalk.level < 3
  const glyph = useAscii ? 'Y' : '❧'
  const elapsed = formatElapsedHuman(input.elapsedMs)
  const tokens = `${formatTokenCount(input.inputTokens)} in / ${formatTokenCount(input.outputTokens)} out`
  return `${color(glyph, theme.primary)} ${color(`Worked for ${elapsed}`, theme.primary)} ${color(`· ${tokens}`, theme.muted)}`
}
