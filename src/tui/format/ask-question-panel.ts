/**
 * ask_user_question 的 Tab 化面板渲染。
 *
 * 交互模型（对齐截图式多题表单）：
 * - 顶部 Tab 条：每题一个 Tab（已答题加 ✓）+ 末尾「提交」Tab，←/→ 自由切换，
 *   不再强制线性答题、答完即自动提交。
 * - 题页：编号选项行（多选带 [ ]/[x]）+ 光标行；末两行固定为
 *   「输入自定义回答…」（Other 输入子模式）与「在输入框中讨论」（= Esc 关闭面板）。
 * - 提交页（Submit Tab）：Review your answers——逐题列出 问题 → 答案
 *   （未答标「将跳过」），用户显式选「提交回答」才组串发出。
 *
 * 只负责渲染；状态机（Tab 切换 / 答题 / 提交）在 engine/app.ts 的 pendingAskFlow。
 */

import { color } from '../engine/ansi.js'
import type { RivetTheme } from '../theme.js'
import { displayWidth, truncateToDisplayWidth } from '../width.js'
import {
  frameTop,
  frameBottom,
  frameLine,
  frameDivider,
  frameFooter,
  CURSOR,
} from './overlay-frame.js'

/** 题页末尾两个固定功能行的文案（行序与 app.ts 键分发一致，改动需同步）。 */
export const ASK_OTHER_ROW_LABEL = '输入自定义回答…'
export const ASK_CHAT_ROW_LABEL = '在输入框中讨论（关闭面板）'
/** 提交页两个动作行。 */
export const ASK_SUBMIT_ROW_LABEL = '提交回答'
export const ASK_CANCEL_ROW_LABEL = '取消'

export interface AskPanelTab {
  /** 题面截断后的短标签。 */
  label: string
  /** 该题是否已有有效答案（选中项或自定义文本）。 */
  answered: boolean
}

export interface AskReviewEntry {
  prompt: string
  /** draftToAnswer 组出的答案；null = 未答（提交时跳过）。 */
  answer: string | null
}

export interface AskQuestionPanelData {
  tabs: AskPanelTab[]
  /** 当前 Tab：0..tabs.length-1 为题页；=== tabs.length 为提交页。 */
  activeTab: number
  /** 题页字段（activeTab < tabs.length 时有效）。 */
  prompt: string
  allowMultiple: boolean
  options: string[]
  /** 多选已勾选项下标。 */
  selected: number[]
  /** 光标行（题页：0..options.length+1；提交页：0=提交 / 1=取消）。 */
  cursor: number
  inputSubMode?: {
    active: boolean
    label: string
    placeholder: string
    value: string
    /** 光标位（value 内 UTF-16 偏移）；缺省 = 末尾。 */
    cursorPos?: number
  }
  /** 提交页字段：逐题答案汇总。 */
  review: AskReviewEntry[]
  /** 硬件光标落点（输入子模式渲染方回填——与 connect/choice-panel 同款）。 */
  caret?: { row: number; col: number } | null
}

/** 题页行数 = 选项数 + 2（Other 行 + 讨论行）。 */
export function askQuestionRowCount(data: Pick<AskQuestionPanelData, 'options'>): number {
  return data.options.length + 2
}

function wrapText(text: string, width: number): string[] {
  const out: string[] = []
  for (const rawLine of text.split('\n')) {
    if (displayWidth(rawLine) <= width) {
      out.push(rawLine)
      continue
    }
    let current = ''
    let currentWidth = 0
    for (const ch of rawLine) {
      const w = displayWidth(ch)
      if (currentWidth + w > width && current.length > 0) {
        out.push(current)
        current = ch
        currentWidth = w
      } else {
        current += ch
        currentWidth += w
      }
    }
    if (current.length > 0) out.push(current)
  }
  return out.length > 0 ? out : ['']
}

/** Tab 条：`← 题1  ✓ 题2  提交 →`，活动 Tab 高亮、已答题带 ✓；超宽时按均分截断标签。 */
function renderTabBar(data: AskQuestionPanelData, width: number, theme: RivetTheme): string {
  const innerWidth = width - 8 // 边框 + 「← 」「 →」
  const segments: { label: string; active: boolean; answered: boolean }[] = data.tabs.map((t, i) => ({
    label: t.label,
    active: i === data.activeTab,
    answered: t.answered,
  }))
  segments.push({ label: '提交', active: data.activeTab === data.tabs.length, answered: false })

  const perTab = Math.max(4, Math.floor((innerWidth - segments.length * 2) / segments.length))
  const parts: string[] = []
  for (const seg of segments) {
    const mark = seg.answered ? '✓ ' : ''
    const plain = `${mark}${truncateToDisplayWidth(seg.label, Math.max(4, perTab - (mark ? 2 : 0)))}`
    parts.push(seg.active ? color(plain, theme.primary, { bold: true }) : color(plain, theme.dim))
  }
  const bar = `${color('← ', theme.dim)}${parts.join('  ')}${color(' →', theme.dim)}`
  return frameLine(` ${bar}`, width, theme)
}

/** 编号选项行：`> 2. [x] 选项文本`。checkbox 为 null 时不渲染方框（功能行/单选）。 */
function renderOptionRow(
  index: number,
  label: string,
  checkbox: boolean | null,
  cursor: boolean,
  width: number,
  theme: RivetTheme,
): string {
  const cursorGlyph = cursor ? color(CURSOR, theme.primary, { bold: true }) : ' '
  const box = checkbox === null ? '' : checkbox ? '[x] ' : '[ ] '
  const prefix = `${index + 1}. ${box}`
  const budget = Math.max(1, width - 6 - displayWidth(prefix) - 2)
  const truncated = truncateToDisplayWidth(label, budget)
  const text = cursor
    ? color(`${prefix}${truncated}`, theme.primary, { bold: true })
    : color(`${prefix}${truncated}`, theme.secondary)
  return frameLine(` ${cursorGlyph} ${text}`, width, theme)
}

export function renderAskQuestionPanel(data: AskQuestionPanelData, width: number, height: number, theme: RivetTheme): string[] {
  const lines: string[] = []
  data.caret = null
  const innerWidth = width - 6
  const onSubmitTab = data.activeTab >= data.tabs.length

  lines.push(frameTop(width, theme))
  lines.push(renderTabBar(data, width, theme))
  lines.push(frameDivider(width, theme))

  if (!onSubmitTab) {
    // ── 题页 ──
    const promptLines = wrapText(data.prompt, innerWidth).slice(0, 3)
    for (const p of promptLines) {
      lines.push(frameLine(`  ${color(p, theme.secondary)}`, width, theme))
    }
    lines.push(frameLine('', width, theme))

    const inputSubMode = data.inputSubMode?.active ? data.inputSubMode : undefined
    const contentBudget = Math.max(3, height - 9 - (inputSubMode ? 2 : 0) - promptLines.length)
    let rows = 0
    for (let i = 0; i < data.options.length && rows < contentBudget; i++) {
      const checked = data.allowMultiple ? data.selected.includes(i) : null
      lines.push(renderOptionRow(i, data.options[i]!, checked, data.cursor === i, width, theme))
      rows++
    }
    // 功能行：Other（输入自定义回答）/ 在输入框中讨论——均无 checkbox
    const otherIdx = data.options.length
    const chatIdx = data.options.length + 1
    if (rows < contentBudget) {
      lines.push(renderOptionRow(otherIdx, ASK_OTHER_ROW_LABEL, null, data.cursor === otherIdx, width, theme))
      rows++
    }
    if (rows < contentBudget) {
      lines.push(renderOptionRow(chatIdx, ASK_CHAT_ROW_LABEL, null, data.cursor === chatIdx, width, theme))
      rows++
    }
    while (rows < contentBudget) {
      lines.push(frameLine('', width, theme))
      rows++
    }

    if (inputSubMode) {
      lines.push(frameDivider(width, theme))
      lines.push(frameLine(` ${color(inputSubMode.label, theme.muted)}`, width, theme))
      // 光标是硬件 caret（格边界、零占位），与 connect/choice-panel 同款——行内不画字形。
      // 超宽窗口化：光标前缀超出可视宽时从行首丢弃（尾部锚定），保光标可见。
      const value = inputSubMode.value
      const pos = Math.min(Math.max(inputSubMode.cursorPos ?? value.length, 0), value.length)
      const max = Math.max(1, width - 8)
      let start = 0
      while (start < pos && displayWidth(value.slice(start, pos)) > max - 1) {
        start += value.codePointAt(start)! > 0xffff ? 2 : 1
      }
      let visible = value.slice(start)
      if (displayWidth(visible) > max) visible = truncateToDisplayWidth(visible, max)
      const shown = visible.length > 0
        ? color(visible, theme.secondary)
        : color(inputSubMode.placeholder, theme.dim)
      data.caret = { row: lines.length + 1, col: 5 + displayWidth(value.slice(start, pos)) }
      lines.push(frameLine(` ${color(CURSOR, theme.primary, { bold: true })} ${shown}`, width, theme))
      lines.push(frameFooter('↵:提交, Esc:返回选项', width, theme, 'subtle'))
    } else {
      const hints: Array<[string, string]> = data.tabs.length > 1
        ? [['←→', '切换'], ['↑↓', '移动']]
        : [['↑↓', '移动']]
      if (data.allowMultiple) hints.push(['空格', '多选'])
      hints.push(['Enter', '确认'], ['Esc', '取消'])
      lines.push(frameFooter(hints.map(([k, a]) => `${k}:${a}`).join(', '), width, theme, 'subtle'))
    }
    lines.push(frameBottom(width, theme))
    return lines
  }

  // ── 提交页（Review your answers） ──
  lines.push(frameLine(`  ${color('确认你的回答', theme.warning, { bold: true })}`, width, theme))
  lines.push(frameLine('', width, theme))
  const reviewBudget = Math.max(2, height - 12)
  let used = 0
  data.review.forEach((entry, i) => {
    if (used + 2 > reviewBudget) return
    const q = truncateToDisplayWidth(entry.prompt.replace(/\s+/g, ' ').trim(), innerWidth - 4)
    lines.push(frameLine(`  ${color(`${i + 1}. ${q}`, theme.secondary)}`, width, theme))
    const answerLine = entry.answer
      ? color(`→ ${truncateToDisplayWidth(entry.answer, innerWidth - 6)}`, theme.success)
      : color('→ （未答，将跳过）', theme.muted)
    lines.push(frameLine(`    ${answerLine}`, width, theme))
    used += 2
  })
  lines.push(frameLine('', width, theme))
  lines.push(frameLine(`  ${color('准备好提交了吗？', theme.secondary)}`, width, theme))
  const actions = [ASK_SUBMIT_ROW_LABEL, ASK_CANCEL_ROW_LABEL]
  actions.forEach((label, i) => {
    const cursor = data.cursor === i
    const cursorGlyph = cursor ? color(CURSOR, theme.primary, { bold: true }) : ' '
    const text = cursor
      ? color(`${i + 1}. ${label}`, theme.primary, { bold: true })
      : color(`${i + 1}. ${label}`, theme.secondary)
    lines.push(frameLine(` ${cursorGlyph} ${text}`, width, theme))
  })
  lines.push(frameFooter('↑↓:移动, Enter:确认, Esc:取消', width, theme, 'subtle'))
  lines.push(frameBottom(width, theme))
  return lines
}
