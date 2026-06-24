/**
 * 显示宽度度量 — 解决 string-width 的窄宽假设与终端实际渲染的错位。
 *
 * 背景：`string-width` 把 East-Asian **Ambiguous** 字符（如 `—` `…` `↑↓` `·`）
 * 一律按 1 列计；但很多终端（尤其 CJK 环境/字体）把这些符号按 2 列渲染。
 * LiveEngine 据 string-width 估算每行占几个显示行（`rowsForLine`），低估后
 * 相对光标回顶量不足 → 旧帧顶部泄漏进 scrollback（输入框重影/重叠）。
 *
 * 关键陷阱：Unicode 把 **box-drawing / block**（U+2500–U+259F，如 `─ │ ╭ █`）
 * 也归为 ambiguous，但终端普遍按 **1 列** 渲染它们。若把所有 ambiguous 当宽，
 * 会把输入框边框算成双宽 → over-erase 反噬 scrollback。因此本模块只对
 * **非 box/block 的 ambiguous 符号** 叠加 +1 宽度增量。
 *
 * 度量建立在 `string-width` 之上（继承其对 emoji/ZWJ/组合符/控制符的正确处理），
 * narrow 模式与 string-width 完全一致（零回归）；wide 模式仅对上述符号 +1。
 */

import stringWidth from 'string-width'
import { eastAsianWidthType } from 'get-east-asian-width'

const ANSI_RE = /\x1B\[[0-9;]*[a-zA-Z]/g
/** 黏附匹配（按位置）用于截断时识别转义序列。 */
const ANSI_STICKY = /\x1B\[[0-9;]*[a-zA-Z]/y
const RESET = '\x1B[0m'

/** box-drawing（U+2500–257F）与 block elements（U+2580–259F）：终端均按 1 列渲染。 */
function isBoxOrBlock(cp: number): boolean {
  return cp >= 0x2500 && cp <= 0x259f
}

/** 一个 code point 在 wide 模式下相对 string-width 的额外宽度（0 或 1）。 */
function ambiguousExtraForCp(cp: number): number {
  if (isBoxOrBlock(cp)) return 0
  return eastAsianWidthType(cp) === 'ambiguous' ? 1 : 0
}

/** 去掉 ANSI 后逐 code point 累计的 ambiguous 额外宽度。 */
function ambiguousExtra(plain: string): number {
  let extra = 0
  for (const ch of plain) {
    const cp = ch.codePointAt(0)
    if (cp === undefined) continue
    extra += ambiguousExtraForCp(cp)
  }
  return extra
}

/** 环境开关：`RIVET_AMBIGUOUS_WIDTH=wide` 时按宽计 ambiguous（CJK 终端推荐）。默认 narrow。 */
export function ambiguousWideEnabled(): boolean {
  return (process.env.RIVET_AMBIGUOUS_WIDTH ?? '').toLowerCase() === 'wide'
}

export interface DisplayWidthOptions {
  /** 把非 box/block 的 ambiguous 符号按 2 列计。默认 false（= string-width 行为）。 */
  ambiguousAsWide?: boolean
}

/** 文本的显示宽度（已忽略 ANSI 转义）。 */
export function displayWidth(text: string, opts: DisplayWidthOptions = {}): number {
  const plain = text.replace(ANSI_RE, '')
  const base = stringWidth(plain)
  if (!opts.ambiguousAsWide) return base
  return base + ambiguousExtra(plain)
}

/**
 * 按显示宽度截断（ANSI 安全：转义序列原样保留、不计宽；截断发生时补一个 RESET
 * 防止颜色泄漏到后续行）。已在预算内则原样返回。
 */
export function truncateToDisplayWidth(text: string, max: number, opts: DisplayWidthOptions = {}): string {
  if (max <= 0) return ''
  if (displayWidth(text, opts) <= max) return text
  const wide = !!opts.ambiguousAsWide
  let out = ''
  let w = 0
  let i = 0
  let sawAnsi = false
  while (i < text.length) {
    ANSI_STICKY.lastIndex = i
    const m = ANSI_STICKY.exec(text)
    if (m && m.index === i) {
      out += m[0]
      i += m[0].length
      sawAnsi = true
      continue
    }
    const cp = text.codePointAt(i)!
    const ch = String.fromCodePoint(cp)
    let cw = stringWidth(ch)
    if (wide) cw += ambiguousExtraForCp(cp)
    if (w + cw > max) break
    out += ch
    w += cw
    i += ch.length
  }
  return sawAnsi ? out + RESET : out
}
