/**
 * T9 格式化函数 — spinner 状态行（运行态指示器）。
 *
 * 对标 Claude Code 的克制形态：单一 spinner 字形（不分相位）+ 一个缓慢轮换的
 * 中文俏皮词 + 计时，例如 `⠹ 推演中… 12s · esc 中断`。
 * - 不再有「思考/书写/运作/待命」多相位 × 多字形 × 各自动画的复杂叙事。
 * - 词从词池里按 elapsed 每 4s 缓慢轮换（确定性、可测、不闪）。
 * - stall（10s 无 token）时整行转琥珀色。
 * - 提供 ASCII fallback 兼容。
 */

import chalk from 'chalk'
import { color } from '../engine/ansi.js'
import type { RivetTheme } from '../theme.js'
import { brailleSpinnerFrame } from '../braille-spinner.js'

export type SpinnerPhase = 'idle' | 'thinking' | 'streaming' | 'waiting' | 'analyzing'

/** CC 风格的运行态俏皮词池（中文，面向中国市场）。按 elapsed 缓慢轮换。 */
const WORD_POOL = [
  '思索中', '推演中', '打磨中', '运筹中', '琢磨中', '梳理中',
  '编织中', '雕琢中', '求索中', '测算中', '沉淀中', '校准中',
] as const

/** 每 4s 推进一个词，独立于 120ms 帧 tick，保持平静不闪。 */
function pickWord(elapsedMs: number): string {
  const idx = Math.floor(Math.max(0, elapsedMs) / 4000) % WORD_POOL.length
  return WORD_POOL[idx]!
}

const ASCII_FRAMES = ['-', '\\', '|', '/'] as const

function spinnerFrame(tick: number, useAscii: boolean): string {
  if (useAscii) return ASCII_FRAMES[((tick % 4) + 4) % 4]!
  return brailleSpinnerFrame(tick)
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
  const frame = spinnerFrame(input.tick, useAscii)
  const word = pickWord(input.elapsedMs)
  const text = `${frame} ${word}… ${formatElapsedHuman(input.elapsedMs)} · esc 中断`
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
  const glyph = useAscii ? 'Y' : '◆'
  const elapsed = formatElapsedHuman(input.elapsedMs)
  const tokens = `${formatTokenCount(input.inputTokens)}→${formatTokenCount(input.outputTokens)}`
  return `${color(glyph, theme.primary)} ${color(`${elapsed}`, theme.primary)} ${color(`· ${tokens}`, theme.muted)}`
}
