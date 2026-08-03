/**
 * `/config` 设置面板渲染 —— 左分类栏 + 右字段区。
 *
 * 复用 overlay-frame 的框线原语；所有宽度计算走 `stringWidth` / display width，
 * 不用 `.length`（CJK 标签占 2 格，用 length 会把右边框顶歪）。
 */

import stringWidth from 'string-width'
import { color } from '../engine/ansi.js'
import { truncateToDisplayWidth } from '../width.js'
import type { RivetTheme } from '../theme.js'
import type { SettingsView } from '../settings-flow.js'
import {
  frameTop,
  frameBottom,
  frameTitleLeft,
  frameFooter,
  frameLine,
  frameDivider,
  CURSOR,
  keyHints,
} from './overlay-frame.js'

/** 框线 + 标题 + 分隔 + 页脚 + 底边共占 5 行。 */
const CHROME_ROWS = 5
const LEFT_MIN = 10
const LEFT_MAX = 20
const RIGHT_MIN = 24

const EFFECT_LABEL: Record<SettingsView['fields'][number]['effect'], string> = {
  immediate: '即时',
  'next-session': '下次会话',
}

/** 定宽单元格：先按显示宽度截断，再右填充到 w。 */
function cell(text: string, w: number): string {
  if (w <= 0) return ''
  const clipped = truncateToDisplayWidth(text, w)
  return clipped + ' '.repeat(Math.max(0, w - stringWidth(clipped)))
}

function leftColumnWidth(view: SettingsView, width: number): number {
  const widest = view.categories.reduce((max, c) => Math.max(max, stringWidth(c.label)), 0)
  // 游标 + 空格 + 标签 + 脏标记
  const desired = Math.min(LEFT_MAX, Math.max(LEFT_MIN, widest + 5))
  const available = width - 2 - 1 - RIGHT_MIN
  return Math.max(0, Math.min(desired, available))
}

/**
 * 计算可见窗口 —— 选中项始终在窗口内，列表比窗口短时不滚动。
 */
function windowStart(index: number, count: number, rows: number): number {
  if (count <= rows || rows <= 0) return 0
  const half = Math.floor(rows / 2)
  return Math.max(0, Math.min(count - rows, index - half))
}

export function renderSettings(view: SettingsView, width: number, height: number, theme: RivetTheme): string[] {
  const lines: string[] = []
  const dirtyCount = view.dirtyBlocks.length
  const title = dirtyCount > 0
    ? `设置 /config   ${color(`● ${dirtyCount} 项未保存`, theme.warning)}`
    : '设置 /config'

  lines.push(frameTop(width, theme, 'subtle'))
  lines.push(frameTitleLeft(title, width, theme))
  lines.push(frameDivider(width, theme))

  const contentRows = Math.max(1, height - CHROME_ROWS)
  // 末行留给提示 / 校验错误 / 保存结果 —— 它占 contentRows 的一行，不是额外加一行，
  // 否则极矮终端（height ≤ 6）总行数会超 height 被 OverlayEngine 静默截掉页脚。
  const listRows = Math.max(0, contentRows - 1)
  const leftW = leftColumnWidth(view, width)
  const divider = color('│', theme.dim)
  const rightW = Math.max(0, width - 2 - leftW - 1)

  const catStart = windowStart(view.categoryIndex, view.categories.length, listRows)
  const rightRows = buildRightRows(view, rightW, theme, listRows)

  const rows: string[] = []
  for (let i = 0; i < listRows; i++) {
    const catIdx = catStart + i
    const cat = view.categories[catIdx]
    let left: string
    if (!cat) {
      left = cell('', leftW)
    } else {
      const selected = catIdx === view.categoryIndex
      const focused = selected && view.focus === 'categories'
      const cursor = focused ? color(CURSOR, theme.primary, { bold: true }) : selected ? color(CURSOR, theme.dim) : ' '
      const mark = cat.dirty ? '*' : ' '
      const labelW = Math.max(0, leftW - 4)
      const plain = cell(cat.label, labelW)
      const tint = selected ? (focused ? theme.primary : theme.secondary) : theme.muted
      left = ` ${cursor} ${color(plain, tint, selected ? { bold: true } : {})}${color(mark, theme.warning)}`
    }
    rows.push(frameLine(`${left}${divider}${rightRows[i] ?? cell('', rightW)}`, width, theme))
  }
  lines.push(...rows)

  lines.push(frameLine(` ${statusLine(view, width - 3, theme)}`, width, theme))
  lines.push(frameFooter(footerHint(view), width, theme, 'subtle'))
  lines.push(frameBottom(width, theme, 'subtle'))
  return lines
}

/** 右栏内容：字段列表 / 枚举选择列表 / 文本编辑缓冲 / 退出确认。 */
function buildRightRows(view: SettingsView, rightW: number, theme: RivetTheme, rows: number): string[] {
  const out: string[] = []
  const pad = (body: string): string => ` ${body}`

  if (view.mode === 'confirm-discard') {
    out.push(pad(color(cell(`有 ${view.dirtyBlocks.length} 项改动未保存`, rightW - 1), theme.warning, { bold: true })))
    out.push(pad(color(cell('Enter 放弃并退出 · Esc 回去继续改 · S 保存', rightW - 1), theme.muted)))
  } else if (view.picker) {
    const { options, index, label } = view.picker
    out.push(pad(color(cell(label, rightW - 1), theme.secondary, { bold: true })))
    const listSpace = Math.max(1, rows - 1)
    const start = windowStart(index, options.length, listSpace)
    for (let i = 0; i < listSpace; i++) {
      const opt = options[start + i]
      if (!opt) break
      const selected = start + i === index
      const cursor = selected ? color(CURSOR, theme.primary, { bold: true }) : ' '
      const text = cell(opt.label, Math.max(0, rightW - 4))
      out.push(pad(`${cursor} ${color(text, selected ? theme.primary : theme.secondary, selected ? { bold: true } : {})}`))
    }
  } else if (view.editor) {
    out.push(pad(color(cell(view.editor.label, rightW - 1), theme.secondary, { bold: true })))
    const cursor = color('▏', theme.primary, { bold: true })
    const buffer = truncateToDisplayWidth(view.editor.buffer, Math.max(0, rightW - 5))
    out.push(pad(`${color('>', theme.primary, { bold: true })} ${color(buffer, theme.secondary)}${cursor}`))
  } else {
    const start = windowStart(view.fieldIndex, view.fields.length, rows)
    // 三列预算必须严格加和到 rightW —— 早期版本对每列各设下限（max(6,…)），
    // 窄终端下下限之和超过 rightW，行宽溢出把右边框顶到下一行。
    const budget = Math.max(0, rightW - 3) // 前导空格 + 游标 + 脏标记
    const effectW = budget >= 24 ? 8 : 0 // 太窄时收起「生效时机」列，提示行仍会说
    const rest = Math.max(0, budget - effectW - 1) // -1 = 标签与取值之间的间隔
    const valueW = Math.min(30, Math.floor(rest / 2))
    const labelW = Math.max(0, rest - valueW)
    for (let i = 0; i < rows; i++) {
      const field = view.fields[start + i]
      if (!field) break
      const selected = start + i === view.fieldIndex
      const focused = selected && view.focus === 'fields'
      const cursor = focused ? color(CURSOR, theme.primary, { bold: true }) : ' '
      const mark = field.dirty ? color('*', theme.warning) : ' '
      const label = color(cell(field.label, labelW), focused ? theme.primary : theme.secondary, focused ? { bold: true } : {})
      const value = color(cell(field.value, valueW), field.dirty ? theme.warning : theme.muted)
      const effect = effectW > 0 ? color(cell(EFFECT_LABEL[field.effect], effectW), theme.dim) : ''
      out.push(pad(`${cursor}${mark}${label} ${value}${effect}`))
    }
  }

  while (out.length < rows) out.push(cell('', rightW))
  return out.slice(0, rows)
}

function statusLine(view: SettingsView, budget: number, theme: RivetTheme): string {
  if (view.error) return color(truncateToDisplayWidth(`✗ ${view.error}`, budget), theme.error)
  if (view.status) return color(truncateToDisplayWidth(view.status, budget), theme.success)
  const field = view.fields[view.fieldIndex]
  const hint = view.editor?.hint ?? field?.hint
  if (hint) return color(truncateToDisplayWidth(hint, budget), theme.muted)
  // 无 hint 兜底：说明面板用途 + 生效语义，比一句干巴巴的路径更有用。
  const cat = view.categories[view.categoryIndex]
  const catName = cat ? cat.label : '当前分类'
  return color(truncateToDisplayWidth(`${catName} · ←→ 切分类 · Enter 编辑 · S 保存（写入 ~/.rivet/config.json，按「即时/下次会话」标注生效）`, budget), theme.dim)
}

function footerHint(view: SettingsView): string {
  switch (view.mode) {
    case 'confirm-discard':
      return keyHints([['Enter', '放弃退出'], ['S', '保存'], ['Esc', '继续编辑']])
    case 'picker':
      return keyHints([['↑↓', '选择'], ['Enter', '确认'], ['Esc', '返回']])
    case 'editor':
      return keyHints([['Enter', '提交'], ['Ctrl-U', '清空'], ['Esc', '返回']])
    case 'browse':
      return keyHints([['↑↓', '移动'], ['Tab/←→', '切栏'], ['Enter', '编辑'], ['S', '保存'], ['Esc', '退出']])
  }
}
