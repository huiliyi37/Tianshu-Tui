/**
 * Plan-review 钉底卡（对标 tianshu-public question-panel plan-review）。
 *
 * 计划正文就是审阅面：标题 + 日期 + 可滚 markdown + ✓/✗ 决策行。
 * 不渲染模型档 / cheap / 低阶产出——审批人只看文档和日期。
 *
 * 纯函数，无 I/O。高度由调用方按终端预算传入 bodyRows，避免把 live 高水位抬死。
 */

import { color } from '../engine/ansi.js'
import type { RivetTheme } from '../theme.js'
import { displayWidth, truncateToDisplayWidth } from '../width.js'
import { formatMarkdown } from './markdown.js'
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
  /** 正文窗口行数（不含标题/决策/提示）。 */
  bodyRows?: number
  countdown?: string
  actions: PlanReviewAction[]
  feedbackMode?: boolean
}

const DEFAULT_BODY_ROWS = 6

/** 本地日历日，避免 UTC 把晚上提交拨到前一天。 */
export function formatPlanReviewDate(d: Date): string {
  const y = d.getFullYear()
  const m = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  return `${y}-${m}-${day}`
}

/** 正文窗口：矮屏至少 4 行，高屏封顶 10，给输入框和其余 chrome 留位。 */
export function planReviewBodyRows(termRows: number): number {
  return Math.max(4, Math.min(10, (termRows || 24) - 14))
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
  return color(` └ …(+${n})`, theme.dim)
}

export function formatPlanReview(input: PlanReviewInput, theme: RivetTheme): string[] {
  const width = Math.max(8, input.width)
  const bodyRows = Math.max(1, input.bodyRows ?? DEFAULT_BODY_ROWS)
  const actions = input.actions
  const mdCols = Math.max(8, width - 2)
  const rendered = input.body.trim().length > 0
    ? formatMarkdown({ text: input.body, columns: mdCols }, theme)
    : [color('（计划正文为空）', theme.muted)]
  const window = Math.max(1, input.countdown ? bodyRows - 1 : bodyRows)
  const hasOverflow = rendered.length > window
  const viewRows = hasOverflow ? Math.max(1, window - 1) : window
  const scroll = clampPlanReviewScroll(input.scroll ?? 0, rendered.length, viewRows)
  const slice = rendered.slice(scroll, scroll + viewRows)
  const remaining = Math.max(0, rendered.length - scroll - slice.length)

  const headerBits = [
    '计划审批',
    `「${input.title}」`,
    input.date,
    rendered.length > 0 ? `${Math.min(scroll + 1, rendered.length)}/${rendered.length}` : undefined,
  ].filter((b): b is string => !!b && b.length > 0)
  const lines: string[] = [color(clip(headerBits.join(' · '), width), theme.muted)]

  if (input.countdown) {
    lines.push(color(clip(`⏳ ${input.countdown}`, width), theme.warning))
  }

  for (const row of slice) {
    lines.push(clip(`  ${row}`, width))
  }
  if (remaining > 0) lines.push(overflowLine(remaining, theme))

  if (input.feedbackMode) {
    lines.push(color(clip('  📝 反馈输入中（Enter 提交 / Esc 返回）', width), theme.muted))
    return lines
  }

  const marks = actions.map((a, i) => {
    const mark = a.kind === 'approve' ? '✓' : '✗'
    const tone = a.kind === 'approve' ? theme.success : theme.dim
    return color(`${mark} ${i + 1} ${a.label}`, tone)
  })
  const actionPlain = actions.map((a, i) => `${a.kind === 'approve' ? '✓' : '✗'} ${i + 1} ${a.label}`).join('   ')
  if (displayWidth(actionPlain, WIDE) <= width - 1) {
    lines.push(` ${marks.join('   ')}`)
  } else {
    for (const mark of marks) lines.push(clip(` ${mark}`, width))
  }

  const hints = actions.map((a, i) => `[${i + 1}]${a.kind === 'approve' ? '批准' : a.id === 'reject-exit' ? '退出' : '驳回'}`)
  hints.push('[f]反馈', '[↑↓]滚动', '[v]搜索', '[Esc]收起')
  lines.push(color(clip(`  ${hints.join('  ')}`, width), theme.dim))
  return lines
}
