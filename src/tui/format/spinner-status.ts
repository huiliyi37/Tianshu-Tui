/**
 * T9 格式化函数 — spinner 状态行（Claude Code 风格）。
 *
 *   ⠋ Thinking… (12s · esc to interrupt)
 *
 * - braille spinner 帧由渲染 ticker 驱动（tick 单调递增）
 * - 动词随 phase 轮换（Thinking/Writing/Working/Waiting）
 * - 10s 无新 token（stalled）→ 琥珀色警示
 */

import { color } from '../engine/ansi.js'
import type { RivetTheme } from '../theme.js'
import { brailleSpinnerFrame } from '../braille-spinner.js'

export type SpinnerPhase = 'idle' | 'thinking' | 'streaming' | 'waiting' | 'analyzing'

const PHASE_VERBS: Record<Exclude<SpinnerPhase, 'idle'>, string> = {
  thinking: '凝思',
  streaming: '书写',
  analyzing: '运作',
  waiting: '候待',
}

/** GlanceBar 用的 phase glyph + 标签 — 五行运行态（对齐设计稿）
 *  ◐ 水·凝思  ✦ 火·书写  ⚙ 风·运作  ▲ 山·候待  ❧ 林·归航 */
export function phaseIndicator(phase: SpinnerPhase): { glyph: string; label: string } {
  switch (phase) {
    case 'thinking': return { glyph: '◐', label: '凝思' }
    case 'streaming': return { glyph: '✦', label: '书写' }
    case 'analyzing': return { glyph: '⚙', label: '运作' }
    case 'waiting': return { glyph: '▲', label: '候待' }
    case 'idle': return { glyph: '▲', label: '候待' }
  }
}

export function formatElapsedHuman(ms: number): string {
  const secs = Math.max(0, Math.floor(ms / 1000))
  if (secs < 60) return `${secs}s`
  return `${Math.floor(secs / 60)}m ${secs % 60}s`
}

export interface SpinnerStatusInput {
  /** 单调递增的渲染 tick（120ms/帧） */
  tick: number
  phase: SpinnerPhase
  /** 本轮已用时间 */
  elapsedMs: number
  /** 超过 10s 无新 token */
  stalled?: boolean
}

/**
 * 格式化 spinner 状态行。idle 时返回 null（不渲染）。
 */
export function formatSpinnerStatus(input: SpinnerStatusInput, theme: RivetTheme): string | null {
  if (input.phase === 'idle') return null
  const frame = brailleSpinnerFrame(input.tick)
  const verb = PHASE_VERBS[input.phase]
  const text = `${frame} ${verb}… (${formatElapsedHuman(input.elapsedMs)} · esc to interrupt)`
  return color(text, input.stalled ? theme.warning : theme.muted)
}

/** token 数量人类可读化：890 / 12.3k / 1.2M */
export function formatTokenCount(n: number): string {
  if (n < 1000) return `${n}`
  if (n < 1_000_000) return `${(n / 1000).toFixed(1)}k`
  return `${(n / 1_000_000).toFixed(2)}M`
}

/** 回合耗时文案：✦ Worked for 1m 6s · 12.3k in / 890 out */
export function formatTurnWorkSummary(input: {
  elapsedMs: number
  inputTokens: number
  outputTokens: number
}, theme: RivetTheme): string {
  const elapsed = formatElapsedHuman(input.elapsedMs)
  const tokens = `${formatTokenCount(input.inputTokens)} in / ${formatTokenCount(input.outputTokens)} out`
  return `${color('✦', theme.primary)} ${color(`Worked for ${elapsed}`, theme.primary)} ${color(`· ${tokens}`, theme.muted)}`
}
