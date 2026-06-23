/**
 * T9 格式化函数 — 首屏欢迎（极简）。
 *
 * 渲染结构：
 *   <北斗七星 2D 星图>
 *   ✦  T I A N S H U  ✦
 *   <model> · <dir> · <session>
 *   Ctrl+C interrupt    Ctrl+Esc palette    Ctrl+R history
 *   Ctrl+O expand       Ctrl+T thinking     Esc Esc rewind
 *   /help commands      \+Enter / Ctrl+J multi-line
 */

import stringWidth from 'string-width'
import { color } from '../engine/ansi.js'
import type { RivetTheme } from '../theme.js'

export interface FormatWelcomeInput {
  modelName: string
  cwd: string
  sessionId: string
  priorMsgCount: number
  columns: number
  /** Ephemeral per-session numeric id (e.g. 7281). When present, shown in the title. */
  numericId?: number
}

function truncateToWidth(text: string, maxWidth: number): string {
  if (maxWidth <= 0) return ''
  if (stringWidth(text) <= maxWidth) return text
  let out = ''
  let w = 0
  for (const ch of text) {
    const cw = stringWidth(ch)
    if (w + cw > maxWidth - 1) break
    out += ch
    w += cw
  }
  return out + '…'
}

// 北斗七星 — 真实勺形布局（基于 HTML 视觉稿比例优化）
// 天枢为首星，落朱砂 ●；余者星尘灰 ·。无连线无框。
const DIPPER_STARS: ReadonlyArray<{ x: number; y: number; lead?: boolean }> = [
  { x: 2, y: 0, lead: true },  // 天枢 (Dubhe) - 朱砂落印
  { x: 4, y: 2 },              // 天璇 (Merak)
  { x: 11, y: 3 },             // 天玑 (Phecda)
  { x: 10, y: 1 },             // 天权 (Megrez)
  { x: 16, y: 1 },             // 玉衡 (Alioth)
  { x: 22, y: 0 },             // 开阳 (Mizar)
  { x: 26, y: 2 },             // 摇光 (Alkaid)
]
const DIPPER_WIDTH = 28
const DIPPER_ROWS = 4

/** 渲染勺形北斗为 ANSI 行（仅当列宽足够时）。 */
function renderDipper(cols: number, theme: RivetTheme): string[] {
  if (cols < DIPPER_WIDTH + 2) return []
  const grid: string[][] = Array.from({ length: DIPPER_ROWS }, () =>
    Array.from({ length: DIPPER_WIDTH }, () => ' '))
  const colored: Array<{ row: number; col: number; glyph: string; lead: boolean }> = []
  for (const s of DIPPER_STARS) {
    if (s.y < DIPPER_ROWS && s.x < DIPPER_WIDTH) {
      grid[s.y]![s.x] = s.lead ? '●' : '·'
      colored.push({ row: s.y, col: s.x, glyph: s.lead ? '●' : '·', lead: !!s.lead })
    }
  }
  return grid.map((row, r) => {
    let out = ''
    for (let c = 0; c < row.length; c++) {
      const ch = row[c]!
      if (ch === ' ') { out += ' '; continue }
      const star = colored.find(s => s.row === r && s.col === c)!
      out += star.lead
        ? color(ch, theme.pulseAlert || theme.userColor, { bold: true }) // 天枢 — 朱砂印
        : color(ch, theme.dim)                                           // 余星 — 星尘灰
    }
    return out.replace(/\s+$/, '')
  })
}

export function formatWelcome(input: FormatWelcomeInput, theme: RivetTheme): string[] {
  const cols = input.columns > 0 ? input.columns : 80
  const out: string[] = []

  // 勺形北斗星图（窄终端自动省略）
  out.push(...renderDipper(cols, theme))

  // ✦  T I A N S H U  ✦ 品牌设计
  const starGlyph = color('✦', theme.pulseAlert || theme.userColor)
  let brandText = `${starGlyph}  ${color('T I A N S H U', theme.primary, { bold: true })}`
  if (input.numericId) {
    brandText += `  ${color('·', theme.dim)}  ${color(`#${input.numericId}`, theme.primary, { bold: true })}`
  }
  brandText += `  ${starGlyph}`
  out.push(brandText)

  const dir = input.cwd.replace(/^.*\//, '')
  const session = input.priorMsgCount > 0
    ? `${input.sessionId.slice(0, 8)} (${input.priorMsgCount} prior)`
    : input.sessionId.slice(0, 8)
  out.push(color(`${input.modelName} · ${dir}/ · ${session}`, theme.dim))
  out.push('')
  out.push(color('Ctrl+C interrupt    Ctrl+Esc palette    Ctrl+R history', theme.dim))
  out.push(color('Ctrl+O expand       Ctrl+T thinking     Esc Esc rewind', theme.dim))
  out.push(color('/help commands      \\+Enter / Ctrl+J multi-line', theme.dim))

  return out.map(line => truncateToWidth(line, cols))
}
