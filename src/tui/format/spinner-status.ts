/**
 * T9 格式化函数 — spinner 状态行（运行态指示器）。
 *
 * 与 commit 37cbed7b 同步：spinner 只承担"正在跑"指示，词静态为 'thinking'，
 * 配合 elapsed 计时，例如 `◐ thinking… 12s`。不再做花活词池轮换，也不再
 * 在末尾追加 esc 中断提示。
 * - stall（10s 无 token）时整行转琥珀色。
 * - 提供 ASCII fallback 兼容。
 */

import chalk from 'chalk'
import { color } from '../engine/ansi.js'
import type { RivetTheme } from '../theme.js'
import { circleSpinnerFrame } from '../braille-spinner.js'

export type SpinnerPhase = 'idle' | 'thinking' | 'streaming' | 'waiting' | 'analyzing'

const ASCII_FRAMES = ['-', '\\', '|', '/'] as const

function spinnerFrame(tick: number, useAscii: boolean): string {
  if (useAscii) return ASCII_FRAMES[((tick % 4) + 4) % 4]!
  return circleSpinnerFrame(tick)
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

const PHASE_LABELS: Record<SpinnerPhase, string> = {
  idle: '',
  thinking: 'thinking…',
  streaming: 'thinking…',
  analyzing: 'thinking…',
  waiting: 'thinking…',
}

export function formatSpinnerStatus(input: SpinnerStatusInput, theme: RivetTheme): string | null {
  if (input.phase === 'idle') return null
  const useAscii = chalk.level < 3
  const frame = spinnerFrame(input.tick, useAscii)
  const label = PHASE_LABELS[input.phase] ?? 'thinking…'
  const text = `${frame} ${label} ${formatElapsedHuman(input.elapsedMs)}`
  const phaseColor: Record<SpinnerPhase, string> = {
    idle: theme.muted,
    thinking: theme.muted,
    streaming: theme.primary,
    analyzing: theme.muted,
    waiting: theme.warning,
  }
  // stall 优先级最高，覆盖 phase 颜色以提示用户
  return color(text, input.stalled ? theme.warning : phaseColor[input.phase])
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
  const glyph = useAscii ? 'Y' : '◆'
  const elapsed = formatElapsedHuman(input.elapsedMs)
  const tokens = `${formatTokenCount(input.inputTokens)}→${formatTokenCount(input.outputTokens)}`
  return `${color(glyph, theme.primary)} ${color(`${elapsed}`, theme.primary)} ${color(`· ${tokens}`, theme.muted)}`
}
