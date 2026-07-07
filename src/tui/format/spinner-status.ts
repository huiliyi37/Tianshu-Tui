/**
 * T9 格式化函数 — spinner 状态行（运行态指示器）。
 *
 * Wave 2 对标改造：spinner 支持动词池轮换（与 worker 面板词池风格统一，
 * activity-labels.ts 同源审美），默认池 + config `ui.spinnerVerbs` 覆盖/追加。
 * 轮换按 elapsed 时间片（8s 一换）而非 tick，避免高频闪词。
 * - stall（10s 无 token）时整行转琥珀色。
 * - reducedMotion：动画帧退化为静态字符、动词不轮换（无障碍）。
 * - 提供 ASCII fallback 兼容。
 */

import chalk from 'chalk'
import { color } from '../engine/ansi.js'
import type { RivetTheme } from '../theme.js'
import { circleSpinnerFrame } from '../braille-spinner.js'

export type SpinnerPhase = 'idle' | 'thinking' | 'streaming' | 'waiting' | 'analyzing'

const ASCII_FRAMES = ['-', '\\', '|', '/'] as const

/** 默认动词池——与 activity-labels.ts worker 词池同风格（中文、凝练、两字动词+中）。 */
const DEFAULT_VERBS = [
  'thinking', '思索中', '推演中', '梳理中', '构筑中', '琢磨中', '沉淀中',
] as const

/** 动词轮换周期（毫秒）——一个词至少停留这么久再换，避免闪烁。 */
const VERB_ROTATE_MS = 8_000

let verbPool: readonly string[] = DEFAULT_VERBS
let reducedMotion = false

/**
 * 配置 spinner 动词池（config `ui.spinnerVerbs` / `ui.spinnerVerbsMode` 接线）。
 * - replace: 完全替换默认池
 * - append: 追加到默认池尾部
 * 空数组视为未配置（保持当前池）。
 */
export function configureSpinnerVerbs(verbs: string[], mode: 'replace' | 'append' = 'replace'): void {
  if (verbs.length === 0) return
  verbPool = mode === 'append' ? [...DEFAULT_VERBS, ...verbs] : [...verbs]
}

/** reducedMotion 无障碍开关：动画帧静态化、动词固定为池首。 */
export function setReducedMotion(value: boolean): void {
  reducedMotion = value
}

/** 重置为默认（测试用）。 */
export function resetSpinnerConfig(): void {
  verbPool = DEFAULT_VERBS
  reducedMotion = false
}

function spinnerFrame(tick: number, useAscii: boolean): string {
  if (reducedMotion) return useAscii ? '*' : '◐'
  if (useAscii) return ASCII_FRAMES[((tick % 4) + 4) % 4]!
  return circleSpinnerFrame(tick)
}

/** 按 elapsed 时间片从池中取动词。reducedMotion 时恒为池首。 */
function verbFor(elapsedMs: number): string {
  if (reducedMotion || verbPool.length === 1) return verbPool[0]!
  const slot = Math.floor(Math.max(0, elapsedMs) / VERB_ROTATE_MS)
  return verbPool[slot % verbPool.length]!
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
  const label = `${verbFor(input.elapsedMs)}…`
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
  // 颜色层级：glyph 是完成指示（accent），耗时/token 是元信息（muted）。
  return `${color(glyph, theme.primary)} ${color(`${elapsed}`, theme.muted)} ${color(`· ${tokens}`, theme.muted)}`
}
