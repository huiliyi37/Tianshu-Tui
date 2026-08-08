/**
 * 长输出塌缩标记 —— 对标 Claude Code 的 `─── ✂ N lines hidden ───`。
 *
 * 此前各处自行拼字符串，同一语义出现过四种写法（`… +N more lines`、
 * `… +N earlier lines`、`… +N 行`、`... N lines hidden ...`），用户在同一屏里
 * 会看到不同形态的「还有内容没显示」。统一到一个可辨识的水平标记：它跨越整行、
 * 带剪刀符，一眼能与正文区分开。
 */

import { useAsciiGlyphs } from '../term-caps.js'

/** 标记两侧的规则线长度（显示列）。 */
const RULE = 3

/**
 * 生成塌缩标记文本（不含颜色）。
 *
 * @param count 被隐藏的行数
 * @param variant `hidden` 为中部省略，`earlier` 为上文省略（错误输出保留尾部时用）
 */
export function hiddenLinesMarker(count: number, variant: 'hidden' | 'earlier' = 'hidden'): string {
  const ascii = useAsciiGlyphs()
  const scissors = ascii ? '--' : '✂'
  const rule = (ascii ? '-' : '─').repeat(RULE)
  const label = variant === 'earlier' ? `已隐藏上文 ${count} 行` : `已隐藏 ${count} 行`
  return `${rule} ${scissors} ${label} ${rule}`
}
