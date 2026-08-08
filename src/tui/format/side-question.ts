/**
 * `/btw` 侧问浮层 —— ANSI 渲染器。
 *
 * 浮层是这个功能的**载体而非装饰**：问与答只存在于这里，关掉即消失，一个字节都不
 * 进对话历史。因此渲染上刻意不做成"像一条对话消息"，避免用户误以为 agent 记住了。
 */

import { color } from '../engine/ansi.js'
import type { RivetTheme } from '../theme.js'
import { uiGlyphs } from '../ui-glyphs.js'
import { wrapByDisplayWidth } from './worker-dispatch-card.js'
import {
  frameTop,
  frameBottom,
  frameTitle,
  frameFooter,
  frameLine,
  keyHints,
} from './overlay-frame.js'

export interface SideQuestionData {
  question: string
  answer: string
  pending: boolean
  error?: string
  /** 回答超出视口时的起始行。 */
  scroll?: number
}

export function renderSideQuestion(
  data: SideQuestionData,
  width: number,
  height: number,
  theme: RivetTheme,
): string[] {
  const w = Math.max(20, width - 4)
  const contentRows = Math.max(3, height - 4)

  const lines: string[] = [
    frameTop(width, theme, 'subtle'),
    frameTitle(`${uiGlyphs().sideQuestion} 侧问 · 不进入对话历史`, width, theme),
  ]

  const body: string[] = []
  for (const q of wrapByDisplayWidth(data.question, w - 2)) {
    body.push(` ${color(q, theme.primary, { bold: true })}`)
  }
  body.push('')

  if (data.error) {
    body.push(` ${color(`回答失败：${data.error}`, theme.error)}`)
  } else if (!data.answer && data.pending) {
    body.push(` ${color('思考中…', theme.dim)}`)
  } else {
    for (const raw of data.answer.split('\n')) {
      if (raw.trim() === '') { body.push(''); continue }
      for (const line of wrapByDisplayWidth(raw, w - 2)) {
        body.push(` ${color(line, theme.secondary)}`)
      }
    }
    if (data.pending) body.push(` ${color('▌', theme.dim)}`)
  }

  // 回答可能长过视口；滚动窗口按 scroll 取，越界钳回末页。
  const maxScroll = Math.max(0, body.length - contentRows)
  const start = Math.max(0, Math.min(data.scroll ?? 0, maxScroll))
  const view = body.slice(start, start + contentRows)

  for (let i = 0; i < contentRows; i++) lines.push(frameLine(view[i] ?? '', width, theme))

  const hints: [string, string][] = maxScroll > 0
    ? [['↑↓', '滚动'], ['Esc/q', '关闭（不留痕）']]
    : [['Esc/q', '关闭（不留痕）']]
  lines.push(frameFooter(keyHints(hints), width, theme, 'subtle'))
  lines.push(frameBottom(width, theme, 'subtle'))
  return lines
}

/** 回答文本的总渲染行数——供滚动边界计算复用，避免与渲染各算各的。 */
export function sideQuestionBodyLines(data: SideQuestionData, width: number): number {
  const w = Math.max(20, width - 4)
  let n = wrapByDisplayWidth(data.question, w - 2).length + 1
  if (data.error) return n + 1
  if (!data.answer && data.pending) return n + 1
  for (const raw of data.answer.split('\n')) {
    n += raw.trim() === '' ? 1 : wrapByDisplayWidth(raw, w - 2).length
  }
  return data.pending ? n + 1 : n
}
