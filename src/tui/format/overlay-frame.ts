/**
 * 共享 overlay 面板骨架 — 所有全屏 overlay 渲染器统一复用。
 *
 * 一套「顶边框 → 居中标题 → padLine 内容 → 底部提示 → 底边框」的盒式骨架，
 * 加上统一的选中光标 / 当前项标记 / 中文快捷键提示生成器。宽度对齐一律用
 * `stringWidth`（CJK/emoji 占 2 格），避免 `.length` 低估导致边框右移。
 */

import stringWidth from 'string-width'
import { color } from '../engine/ansi.js'
import type { RivetTheme } from '../theme.js'

/** 选中项游标（bold primary）。全 overlay 统一，替代历史上的 ▸ / ❯。 */
export const CURSOR = '▶'
/** 当前生效项标记（如当前会话 / 当前模型 / 当前主题）。 */
export const CURRENT_MARK = '●'

/** 顶边框。 */
export function frameTop(width: number, theme: RivetTheme): string {
  return color('┌' + '─'.repeat(Math.max(0, width - 2)) + '┐', theme.dim)
}

/** 底边框。 */
export function frameBottom(width: number, theme: RivetTheme): string {
  return color('└' + '─'.repeat(Math.max(0, width - 2)) + '┘', theme.dim)
}

/** 居中标题栏。 */
export function frameTitle(title: string, width: number, theme: RivetTheme): string {
  const padded = ` ${title} `
  const remaining = Math.max(0, width - 2 - stringWidth(padded))
  const left = Math.floor(remaining / 2)
  const right = remaining - left
  return color('│' + ' '.repeat(left) + padded + ' '.repeat(right) + '│', theme.dim)
}

/** 底部快捷键提示行（左对齐、整行 dim；超宽保留右端关闭提示）。 */
export function frameFooter(hint: string, width: number, theme: RivetTheme): string {
  const maxHintWidth = Math.max(0, width - 4) // 2 borders + 1 space each side
  let visibleHint = hint
  if (stringWidth(visibleHint) > maxHintWidth) {
    let suffix = ''
    let suffixWidth = 0
    const chars = Array.from(hint)
    for (let i = chars.length - 1; i >= 0; i--) {
      const cw = stringWidth(chars[i]!)
      if (suffixWidth + cw + 1 > maxHintWidth) break // +1 for leading ellipsis
      suffix = chars[i]! + suffix
      suffixWidth += cw
    }
    visibleHint = '…' + suffix
  }
  const padded = ` ${visibleHint} `
  const remaining = width - 2 - stringWidth(padded)
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
