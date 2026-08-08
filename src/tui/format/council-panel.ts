/**
 * T9 格式化函数 — 议事会终态 verdict 卡（scrollback）。
 *
 * council_convene 的 CouncilPanelModel 帧（rivet:council-panel:v1:）在终态经
 * uiContent 通道发射，TUI 的 handleToolResult 解码后 commit 进 scrollback。
 * 本卡与 team 终态的 formatTeamPanel 分支同构：运行态分组走 ActivityStore 投影
 * + formatActivityBand（chrome 段），这里只负责终态 verdict 落盘。
 *
 * 行结构（与 team-panel 同一套 Segment 分段上色）：
 *  - 头行：♟ 议事会 · {N} 席 · {objective}
 *  - 席位逐行：{glyph} {域} · r{round}  {status}  {modelUsed}
 *  - verdict 行：{accepted} 通过 · {rejected} 驳回 · {deferred} 待议 · {conflicts} 冲突
 *  - 密封行：sealVersion 存在时给版本号
 *  - 失败席行：failedSeats 非空时单列一行
 *
 * buildCouncilPanelLines 输出纯文本（宽度计算/测试用），formatCouncilPanel 输出
 * 分段上色的 ANSI 行——两者出自同一 entry 构建器，保证结构一致。
 */

import { color } from '../engine/ansi.js'
import type { RivetTheme } from '../theme.js'
import type { CouncilPanelModel, CouncilPanelSeat } from '../council-panel-model.js'
import { authorityStarName, statusWord } from './profile-labels.js'
import { displayWidth, truncateToDisplayWidth } from '../width.js'

type Segment = { text: string; colorKey?: keyof RivetTheme; bold?: boolean }
type PanelLine = Segment[]

function seg(text: string, colorKey?: keyof RivetTheme, bold?: boolean): Segment {
  return bold ? { text, colorKey: colorKey ?? 'primary', bold } : (colorKey ? { text, colorKey } : { text })
}

const WIDE = { ambiguousAsWide: true }

/** 席位状态 glyph：与 worker-fleet 同口径（passed=✓ / failed=✗ / escalated=↑）。 */
function seatGlyph(status: CouncilPanelSeat['status']): string {
  switch (status) {
    case 'running': return '◐'
    case 'passed': return '✓'
    case 'failed': return '✗'
    case 'escalated': return '↑'
    default: return '◌'
  }
}

function seatColorKey(status: CouncilPanelSeat['status']): keyof RivetTheme {
  switch (status) {
    case 'running': return 'primary'
    case 'passed': return 'success'
    case 'failed': return 'error'
    case 'escalated': return 'warning'
    default: return 'dim'
  }
}

/** 域显示名：星名优先（破军），未知域回退原始 id（与 fleet detail 同口径）。 */
function domainLabel(authority: string): string {
  return authorityStarName(authority) ?? authority
}

/** 省略号自身的显示宽度：`…` 在 ambiguous-wide 口径下占 2 列，预留 1 列会溢出。 */
const ELLIPSIS_W = displayWidth('…', WIDE)

function truncate(text: string, max: number): string {
  if (max <= 0) return ''
  const flat = text.replace(/\s+/g, ' ').trim()
  if (displayWidth(flat, WIDE) <= max) return flat
  return `${truncateToDisplayWidth(flat, Math.max(1, max - ELLIPSIS_W), WIDE)}…`
}

function buildEntries(model: CouncilPanelModel, width: number): PanelLine[] {
  const rule = Math.min(Math.max(48, width), 76)
  const out: PanelLine[] = []
  const seats = model.seats
  const objective = model.objective

  // ── 头行：♟ 议事会 · {N} 席 · {objective} ─────────────────
  const headPrefix = `♟ 议事会 · ${seats.length} 席 · `
  const head: PanelLine = [
    seg('♟ ', 'primary'),
    seg('议事会', 'secondary', true),
    seg(` · ${seats.length} 席`, 'muted'),
  ]
  if (objective) {
    const budget = rule - displayWidth(headPrefix, WIDE)
    head.push(seg(' · ', 'dim'), seg(truncate(objective, Math.max(8, budget)), 'dim'))
  }
  out.push(head)

  // ── 席位逐行：{glyph} {域} · r{round}  {status}  {modelUsed} ──
  // 每席恒 1 行；域显示名右对齐前的预算按 display-width 计算，避免长域折行。
  for (const seat of seats) {
    const glyph = seatGlyph(seat.status)
    const glyphColor = seatColorKey(seat.status)
    const word = statusWord(seat.status)
    // 骨架（除域名与模型名外的固定部分）先占额，剩下的预算依次分给可变段——
    // 只截断域名而放任 modelUsed 原样输出会溢出：模型名可以很长
    // （deepseek-v4-thinking-max 一类），超宽行在终端折行后 rowsForLine 少算。
    const skeletonW = displayWidth(` ${glyph}  · r${seat.round}  ${word}`, WIDE)
    const domain = truncate(domainLabel(seat.authority), Math.max(4, rule - skeletonW - (seat.modelUsed ? 6 : 0)))
    const usedW = displayWidth(` ${glyph} ${domain} · r${seat.round}  ${word}`, WIDE)
    const modelBudget = rule - usedW - 2
    const model = seat.modelUsed && modelBudget > 0 ? truncate(seat.modelUsed, modelBudget) : undefined
    const line: PanelLine = [
      seg(' '),
      seg(glyph, glyphColor),
      seg(' '),
      seg(domain, seat.status === 'passed' ? undefined : 'muted'),
      seg(' · ', 'dim'),
    ]
    line.push(seg(`r${seat.round}`, 'secondary'))
    line.push(seg('  '), seg(word, glyphColor))
    if (model) line.push(seg('  '), seg(model, 'muted'))
    out.push(line)
  }

  // ── verdict 行：{accepted} 通过 · {rejected} 驳回 · {deferred} 待议 · {conflicts} 冲突 ──
  const v = model.verdict
  const verdictLine: PanelLine = [seg(' 裁决 ', 'muted')]
  const verdictParts: Array<{ text: string; colorKey: keyof RivetTheme }> = [
    { text: `${v.accepted} 通过`, colorKey: 'success' },
    { text: `${v.rejected} 驳回`, colorKey: 'error' },
    { text: `${v.deferred} 待议`, colorKey: 'muted' },
    { text: `${v.conflicts} 冲突`, colorKey: 'warning' },
  ]
  for (let i = 0; i < verdictParts.length; i++) {
    if (i > 0) verdictLine.push(seg(' · ', 'dim'))
    const p = verdictParts[i]!
    verdictLine.push(seg(p.text, p.colorKey))
  }
  out.push(verdictLine)

  // ── 密封行：sealVersion 存在时给版本号 ───────────────────────
  if (typeof model.sealVersion === 'number') {
    out.push([seg(' ⛭ ', 'success'), seg(`密封 v${model.sealVersion}`, 'success', true)])
  }

  // ── 失败席行：failedSeats 非空时单列一行 ─────────────────────
  if (model.failedSeats && model.failedSeats.length > 0) {
    const names = model.failedSeats.map(domainLabel).join('、')
    // 预算按前缀实际显示宽度扣减：` ✗ 失败席：` 里 CJK 与 ✗ 都按 2 列算，
    // 常数 6 会低估一半。
    const prefixW = displayWidth(' ✗ 失败席：', WIDE)
    out.push([seg(' ✗ ', 'error'), seg(`失败席：${truncate(names, Math.max(4, rule - prefixW))}`, 'error')])
  }

  return out
}

/**
 * 生成议事会 verdict 卡的纯文本行（无颜色，便于宽度计算/测试）。
 */
export function buildCouncilPanelLines(model: CouncilPanelModel, width = 80): string[] {
  return buildEntries(model, width).map(line => line.map(s => s.text).join(''))
}

/**
 * 渲染议事会 verdict 卡为分段上色的 ANSI 行（scrollback 终态卡）。
 */
export function formatCouncilPanel(model: CouncilPanelModel, theme: RivetTheme, width = 80): string[] {
  return buildEntries(model, width).map(line =>
    line.map(s => {
      if (!s.colorKey) return s.text
      const accent = theme[s.colorKey] as string
      return s.bold ? color(s.text, accent, { bold: true }) : color(s.text, accent)
    }).join(''),
  )
}
