/**
 * T9 格式化函数 — 首屏欢迎。
 *
 * 精简版（≤7 行）：
 *   <勺形北斗星图，天枢首星朱砂落印>
 *   天枢 · Tiānshū
 *   <model> · <cwd> · <session>
 *   /help commands · @ files · Ctrl+C exit
 *
 * 按终端宽度自适应（display-width aware 截断），窄终端自动省略星图。
 */

import stringWidth from 'string-width'
import { color } from '../engine/ansi.js'
import type { RivetTheme } from '../theme.js'

export interface FormatWelcomeInput {
  modelName: string
  cwd: string
  sessionId: string
  /** 已恢复的历史消息数（>0 时提示 prior msgs） */
  priorMsgCount: number
  /** 终端列宽 */
  columns: number
}

/** 按显示宽度截断（保留尾部省略号），ANSI-aware 由 string-width 处理。 */
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

/** 缩短 CWD：超长时保留尾部（最有信息量的工作目录名）。 */
function shortenCwd(cwd: string, budget: number): string {
  if (cwd.length <= budget) return cwd
  return '…' + cwd.slice(-(budget - 1))
}

// 北斗七星 · 真·勺形布局（与 v2 设计稿同源坐标，%）：
// 勺斗4星(天枢·天璇·天玑·天权) + 勺柄3星(玉衡·开阳·摇光)。
// 天枢为勺口首星，落朱砂 ●；余者星尘灰 ·。无连线无框。
const DIPPER_STARS: ReadonlyArray<{ x: number; y: number; lead?: boolean }> = [
  { x: 4, y: 0, lead: true }, // 天枢 — 勺口·上 (Dubhe)
  { x: 4, y: 2 },             // 天璇 — 勺口·下 (Merak)
  { x: 10, y: 3 },            // 天玑 — 勺底·下 (Phecda)
  { x: 11, y: 1 },            // 天权 — 勺底·上 (Megrez)
  { x: 16, y: 1 },            // 玉衡 — 柄 (Alioth)
  { x: 21, y: 1 },            // 开阳 — 柄 (Mizar)
  { x: 25, y: 0 },            // 摇光 — 柄端 (Alkaid)
]
const DIPPER_WIDTH = 26
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
        ? color(ch, theme.userColor, { bold: true }) // 天枢 — 朱砂印
        : color(ch, theme.dim)                          // 余星 — 星尘灰
    }
    return out.replace(/\s+$/, '')
  })
}

export function formatWelcome(input: FormatWelcomeInput, theme: RivetTheme): string[] {
  const cols = input.columns > 0 ? input.columns : 80

  const out: string[] = []

  // 勺形北斗星图（窄终端自动省略）
  out.push(...renderDipper(cols, theme))

  // 标题行：天枢 · Tiānshū
  const titleZh = color('天枢', theme.primary, { bold: true })
  const titleRo = color('Tiānshū', theme.muted)
  const title = `${titleZh} ${color('·', theme.dim)} ${titleRo}`
  out.push(title)

  const session = input.priorMsgCount > 0
    ? `${input.sessionId.slice(0, 8)} (${input.priorMsgCount} prior)`
    : input.sessionId.slice(0, 8)
  const cwd = shortenCwd(input.cwd, Math.max(10, cols - session.length - input.modelName.length - 12))
  const meta = `${input.modelName}  ·  ${cwd}  ·  ${session}`

  const hint = '/help commands · @ files · \\⏎ newline · Ctrl+C exit'

  out.push(color(truncateToWidth(meta, cols), theme.muted))
  out.push(color(truncateToWidth(hint, cols), theme.dim))

  // 确保所有行在窄终端下严格不溢出列宽
  return out.map(line => truncateToWidth(line, cols))
}
