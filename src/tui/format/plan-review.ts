/**
 * Plan-review 钉底卡（对标 tianshu-public question-panel plan-review）。
 *
 * 计划正文就是审阅面：标题入顶边框线 + 可滚 markdown + 分隔线隔出决策区 +
 * 底边框内嵌键帽提示。容器与输入框同族（boxCharsFor 同 separator 风格、
 * primary 边框）——它是屏上唯一等待决策的面板，层级必须高于正文流。
 * 不渲染模型档 / cheap / 低阶产出——审批人只看文档和日期。
 *
 * 纯函数，无 I/O。高度由调用方按终端预算传入 bodyRows，避免把 live 高水位抬死。
 */

import { color } from '../engine/ansi.js'
import type { RivetTheme } from '../theme.js'
import { displayWidth, truncateToDisplayWidth } from '../width.js'
import stringWidth from 'string-width'
import { formatMarkdown } from './markdown.js'
import { boxCharsFor } from '../box-chars.js'
import type { PlanSubmittedInfo } from '../../tools/types.js'

const WIDE = { ambiguousAsWide: true }

export interface PlanReviewAction {
  id: string
  label: string
  kind: 'approve' | 'reject'
  recommended?: boolean
}

export interface PlanReviewInput {
  title: string
  /** 提交日期（YYYY-MM-DD）。缺席则不标。 */
  date?: string
  body: string
  scroll?: number
  width: number
  /** 正文窗口行数（不含边框/分隔线/决策行）。 */
  bodyRows?: number
  countdown?: string
  actions: PlanReviewAction[]
  feedbackMode?: boolean
  /** 输入框分隔符风格——审批卡边框与输入框同族（thin/thick/dots/kimi）。 */
  separator?: string
}

const DEFAULT_BODY_ROWS = 6

/** 本地日历日，避免 UTC 把晚上提交拨到前一天。 */
export function formatPlanReviewDate(d: Date): string {
  const y = d.getFullYear()
  const m = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  return `${y}-${m}-${day}`
}

/** 正文窗口：矮屏至少 4 行，高屏封顶 9，给边框/决策区/输入框留位。 */
export function planReviewBodyRows(termRows: number): number {
  return Math.max(4, Math.min(9, (termRows || 24) - 15))
}

export function clampPlanReviewScroll(scroll: number, total: number, window: number): number {
  const max = Math.max(0, total - Math.max(1, window))
  if (!Number.isFinite(scroll)) return 0
  return Math.min(max, Math.max(0, Math.trunc(scroll)))
}

export function buildPlanReviewActions(info: PlanSubmittedInfo): PlanReviewAction[] {
  const actions: PlanReviewAction[] = []
  const options = info.options ?? []
  if (options.length > 1) {
    for (const [i, o] of options.entries()) {
      const recommended = /recommended/i.test(o.label)
      const cleanLabel = o.label.replace(/\s*[(（]?\s*recommended\s*[)）]?/i, '').trim()
      actions.push({
        id: `approve:${i}`,
        label: `批准 — ${cleanLabel}`,
        kind: 'approve',
        recommended,
      })
    }
  } else {
    actions.push({ id: 'approve', label: '批准并执行', kind: 'approve', recommended: true })
  }
  actions.push(
    { id: 'reject', label: '驳回修订', kind: 'reject' },
    { id: 'reject-exit', label: '驳回并退出', kind: 'reject' },
  )
  return actions
}

export function recommendedPlanReviewAction(actions: readonly PlanReviewAction[]): PlanReviewAction | undefined {
  return actions.find(a => a.recommended) ?? actions.find(a => a.kind === 'approve') ?? actions[0]
}

function clip(text: string, width: number): string {
  return truncateToDisplayWidth(text, Math.max(1, width - 1), WIDE)
}

function overflowLine(n: number, theme: RivetTheme): string {
  return color(`└ …(+${n})`, theme.dim)
}

/** 框体内容行：左右边线 + 内容按显示宽补齐到 inner（右边线恒对齐，框不折行）。 */
function frameRow(text: string, inner: number, chars: { v: string }, border: string): string {
  const pad = Math.max(0, inner - stringWidth(text))
  return color(chars.v + ' ', border) + text + ' '.repeat(pad) + color(' ' + chars.v, border)
}

export function formatPlanReview(input: PlanReviewInput, theme: RivetTheme): string[] {
  const width = Math.max(8, input.width)
  const chars = boxCharsFor(input.separator ?? 'thin')
  const bodyRows = Math.max(1, input.bodyRows ?? DEFAULT_BODY_ROWS)
  const actions = input.actions
  const border = theme.primary
  // 框体内宽：`│ ` + content + ` │`；外宽 = inner + 4 = width
  const inner = Math.max(4, width - 4)
  const mdCols = Math.max(8, inner - 1)
  const rendered = input.body.trim().length > 0
    ? formatMarkdown({ text: input.body, columns: mdCols }, theme)
    : [color('（计划正文为空）', theme.muted)]
  const window = Math.max(1, input.countdown ? bodyRows - 1 : bodyRows)
  const hasOverflow = rendered.length > window
  const viewRows = hasOverflow ? Math.max(1, window - 1) : window
  const scroll = clampPlanReviewScroll(input.scroll ?? 0, rendered.length, viewRows)
  const slice = rendered.slice(scroll, scroll + viewRows)
  const remaining = Math.max(0, rendered.length - scroll - slice.length)

  const lines: string[] = []

  // 顶边框：╭─ ☰ 计划审批 · 「title」 · date ──── 1/82 ─╮ —— 标题入框线
  // （wayfinding：这是什么 / 我在批哪个 / 读到哪）。空间不够先丢日期、再裁标题，
  // 「☰ 计划审批」标识与滚动位保底。
  const scrollBit = rendered.length > 0 ? `${Math.min(scroll + 1, rendered.length)}/${rendered.length}` : undefined
  // 边框按物理列宽（stringWidth，歧义字符 1 列）计算——与 frameRow/输入框同口径，
  // displayWidth(WIDE) 会把 ─/☰/· 算 2 列导致填充短少、右边线参差。
  const topPlain = (l: string, withScroll: boolean): number =>
    stringWidth(`─ ${l} ${withScroll && scrollBit ? `${scrollBit} ` : ''}`)
  let label = `☰ 计划审批 · ${input.title}${input.date ? ` · ${input.date}` : ''}`
  if (topPlain(label, true) > width - 4) label = `☰ 计划审批 · ${input.title}`
  if (topPlain(label, true) > width - 4) {
    label = truncateToDisplayWidth(`☰ 计划审批 · ${input.title}`, Math.max(8, width - 6 - displayWidth(scrollBit ?? '', WIDE)), WIDE)
  }
  {
    const right = scrollBit ? ` ${scrollBit} ` : ''
    const fill = Math.max(1, width - 5 - stringWidth(label) - stringWidth(right))
    lines.push(color(`${chars.tl}${chars.h} ${label} `, border)
      + color(chars.h.repeat(fill), border)
      + (right ? color(right, theme.muted) : '')
      + color(chars.tr, border))
  }

  if (input.countdown) {
    lines.push(frameRow(clip(color(`⏳ ${input.countdown}`, theme.warning), inner), inner, chars, border))
  }

  for (const row of slice) {
    lines.push(frameRow(clip(row, inner), inner, chars, border))
  }
  if (remaining > 0) lines.push(frameRow(clip(overflowLine(remaining, theme), inner), inner, chars, border))

  if (input.feedbackMode) {
    lines.push(frameRow(clip(color('📝 反馈输入中（Enter 提交 / Esc 返回）', theme.muted), inner), inner, chars, border))
    lines.push(color(`${chars.bl}${chars.h.repeat(width - 2)}${chars.br}`, border))
    return lines
  }

  // 决策区分隔线——正文与可操作区在此分界（grouping：分隔线宣示「从这里开始是按钮」）
  lines.push(color(`${chars.v}${chars.h.repeat(width - 2)}${chars.v}`, theme.dim))

  // 决策行：推荐动作 ❯ + primary 加粗（屏上唯一主操作）；approve 系 success；
  // reject 回到普通文本色——三层对比让「按哪个」不用读字就看得见。
  const recommended = recommendedPlanReviewAction(actions)
  const actionPieces = actions.map((a, i) => {
    const mark = a.kind === 'approve' ? '✓' : '✗'
    const markColor = a.kind === 'approve' ? theme.success : theme.muted
    const labelColor = a.kind === 'approve' ? theme.success : theme.secondary
    const body = `${mark} ${i + 1} ${a.label}`
    if (a === recommended) {
      return color('❯ ', theme.primary, { bold: true }) + color(body, theme.success, { bold: true })
    }
    return `  ${color(mark, markColor)} ${color(`${i + 1} ${a.label}`, labelColor)}`
  })
  const actionPlain = actions.map((a, i) => `${a.kind === 'approve' ? '✓' : '✗'} ${i + 1} ${a.label}`).join('    ')
  const recPrefix = recommended ? 2 : 0
  if (stringWidth(actionPlain) + recPrefix <= inner - 1) {
    lines.push(frameRow(actionPieces.join('    '), inner, chars, border))
  } else {
    for (const piece of actionPieces) {
      lines.push(frameRow(clip(piece, inner), inner, chars, border))
    }
  }

  // 底边框内嵌键帽提示（frameFooter 语义）：空间不够从尾部丢通用提示，保 [1][2][3]
  const allHints = ['[1]批准', '[2]驳回', '[3]退出', '[f]反馈', '[↑↓]滚动', '[v]搜索', '[Esc]收起']
  let hints = allHints.join(' ')
  const maxHints = width - 7
  if (stringWidth(hints) > maxHints) {
    hints = allHints.slice(0, 3).join(' ')
    for (const h of allHints.slice(3)) {
      if (stringWidth(`${hints}  ${h}`) > maxHints) break
      hints += `  ${h}`
    }
  }
  const hintFill = Math.max(1, width - 5 - stringWidth(hints))
  lines.push(color(`${chars.bl}${chars.h} `, border)
    + color(hints, theme.dim)
    + color(` ${chars.h.repeat(hintFill)}${chars.br}`, border))
  return lines
}
