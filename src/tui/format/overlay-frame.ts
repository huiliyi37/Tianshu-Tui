/**
 * 共享 overlay 面板骨架 — 所有全屏 overlay 渲染器统一复用。
 *
 * 两套风格：
 * - `subtle`（默认）：左对齐标题、紧凑快捷键提示、细边框
 * - `full`：传统框线 + 居中标题（向后兼容，可选）
 *
 * 宽度对齐一律用 `stringWidth`（CJK/emoji 占 2 格），避免 `.length` 低估导致边框右移。
 */

import stringWidth from 'string-width'
import { color } from '../engine/ansi.js'
import type { RivetTheme } from '../theme.js'

/** 选中项游标（bold primary）。全 overlay 统一，替代历史上的 ▸ / ❯。 */
export const CURSOR = '>'
/** 当前生效项标记（如当前会话 / 当前模型 / 当前主题）。 */
export const CURRENT_MARK = '●'

/** 边框风格枚举。 */
export type BorderStyle = 'subtle' | 'full'

/** 默认边框风格。 */
export const DEFAULT_BORDER: BorderStyle = 'subtle'

/** 顶边框（subtle 风格：细顶线；full 风格：┌─┐）。 */
export function frameTop(width: number, theme: RivetTheme, style?: BorderStyle): string {
  const s = style ?? DEFAULT_BORDER
  if (s === 'full') {
    return color('┌' + '─'.repeat(Math.max(0, width - 2)) + '┐', theme.dim)
  }
  // subtle: 细顶线，但仍占满 width 列（用 │ 占位左右）
  return color('│' + '─'.repeat(Math.max(0, width - 2)) + '│', theme.dim)
}

/** 底边框（subtle 风格：细底线；full 风格：└─┘）。 */
export function frameBottom(width: number, theme: RivetTheme, style?: BorderStyle): string {
  const s = style ?? DEFAULT_BORDER
  if (s === 'full') {
    return color('└' + '─'.repeat(Math.max(0, width - 2)) + '┘', theme.dim)
  }
  // subtle: 细底线，但仍占满 width 列
  return color('│' + '─'.repeat(Math.max(0, width - 2)) + '│', theme.dim)
}

/** 居中标题栏（full 风格用）。 */
export function frameTitleCenter(title: string, width: number, theme: RivetTheme): string {
  const padded = ` ${title} `
  const remaining = Math.max(0, width - 2 - stringWidth(padded))
  const left = Math.floor(remaining / 2)
  const right = remaining - left
  return color('│' + ' '.repeat(left) + padded + ' '.repeat(right) + '│', theme.dim)
}

/** 左对齐标题栏（subtle 风格用）。 */
export function frameTitleLeft(title: string, width: number, theme: RivetTheme): string {
  const padded = ` ${title} `
  const remaining = Math.max(0, width - 2 - stringWidth(padded))
  return color('│' + padded + ' '.repeat(remaining) + '│', theme.dim)
}

/** @deprecated Use frameTitleLeft or frameTitleCenter explicitly. */
export const frameTitle = frameTitleLeft

/** 底部快捷键提示行。 */
export function frameFooter(hint: string, width: number, theme: RivetTheme, style?: BorderStyle): string {
  const s = style ?? DEFAULT_BORDER
  // subtle 风格下括号占 2 display columns，故可用 hint 宽度少 2
  const hintBudget = s === 'subtle' ? Math.max(0, width - 6) : Math.max(0, width - 4)
  let visibleHint = hint
  if (stringWidth(visibleHint) > hintBudget) {
    let suffix = ''
    let suffixWidth = 0
    const chars = Array.from(hint)
    for (let i = chars.length - 1; i >= 0; i--) {
      const cw = stringWidth(chars[i]!)
      if (suffixWidth + cw + 1 > hintBudget) break // +1 for leading ellipsis
      suffix = chars[i]! + suffix
      suffixWidth += cw
    }
    visibleHint = '…' + suffix
  }
  if (s === 'full') {
    const padded = ` ${visibleHint} `
    const remaining = width - 2 - stringWidth(padded)
    return color('│' + padded + ' '.repeat(Math.max(0, remaining)) + '│', theme.dim)
  }
  // subtle: 紧凑括号格式
  const compact = `(${visibleHint})`
  const padded = ` ${compact} `
  const hintPaddedWidth = stringWidth(padded)
  const remaining = width - 2 - hintPaddedWidth
  return color('│' + padded + ' '.repeat(Math.max(0, remaining)) + '│', theme.dim)
}

/** 内容行：左右加竖边框并右填充到框宽（内容自带的 ANSI 会被 stringWidth 剥离）。 */
export function frameLine(text: string, width: number, theme: RivetTheme): string {
  const padding = Math.max(0, width - 2 - stringWidth(text))
  return color('│', theme.dim) + text + ' '.repeat(padding) + color('│', theme.dim)
}

/** 框内整宽分隔线（dim）。 */
export function frameDivider(width: number, theme: RivetTheme): string {
  return frameLine(color('─'.repeat(Math.max(0, width - 4)), theme.dim), width, theme)
}

/**
 * 统一生成中文快捷键提示串。组间用 3 空格分隔，键与动作用 1 空格。
 * 例：keyHints([['↑↓','选择'],['Enter','确认'],['Esc','取消']])
 *   → "↑↓ 选择   Enter 确认   Esc 取消"
 */
export function keyHints(pairs: [key: string, action: string][]): string {
  return pairs.map(([k, a]) => `${k} ${a}`).join('   ')
}

// ── 向后兼容别名（overlay.ts 使用这些别名）──────────────────────

/** @deprecated Use frameTop(width, theme, 'full') for old behavior. */
export const formatBorder = frameTop
/** @deprecated Use frameBottom(width, theme, 'full') for old behavior. */
export const formatBottomBorder = frameBottom
/** @deprecated Use frameTitleCenter for old behavior. */
export const formatTitleBar = frameTitleCenter
/** @deprecated Use frameFooter(hint, width, theme, 'full') for old behavior. */
export const formatFooter = frameFooter