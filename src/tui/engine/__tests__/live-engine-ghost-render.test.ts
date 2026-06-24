/**
 * Ghost 渲染复现测试 — 输入框重叠（双边框）根因定位。
 *
 * 现象：两帧连续渲染后，第一帧的顶框（╭──...──╮）未被擦除，
 *       第二帧的顶框叠加在上，形成双边框重叠。
 *
 * 根因假设：
 *   A) rowsForLine 对含 ANSI 码的行宽度计算偏大 → lastDisplayRows 偏小
 *      → cursorUp 量不足 → ERASE_SCREEN_END 擦不到第一帧部分行
 *   B) buildDiff 在行内容变化但结构不变时，对首行（顶框）的 ERASE_LINE 失效
 *      （顶框含 ANSI 色码，lineCache 缓存的是旧帧文本，new text !== cached text
 *       触发 ERASE_LINE，但 ERASE_LINE 只擦当前物理行，无法处理 wrap 行）
 *
 * 本测试用 screen-buffer MockTerminal 逐帧比对，抓到残留即 RED。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { WriteStream } from 'node:tty'
import { LiveEngine, type LiveRegionLine } from '../live-engine.js'
import { displayWidth } from '../../width.js'

/**
 * screen-buffer 终端模拟器：追踪整屏内容（display rows × columns 网格）。
 * 可打印字符绘制到网格，CSI 序列更新光标/擦除，\n/\r 控制换行。
 * 关键：ERASE_SCREEN_END (CSI 0J) 和 ERASE_LINE (CSI 2K) 准确建模擦除行为。
 */
class ScreenTerminal {
  columns: number
  rows: number
  cursorRow = 0
  cursorCol = 0
  /** 是否把非 box/block 的 ambiguous 符号（— … ↑↓ ·）按 2 列渲染（模拟 CJK 终端）。 */
  ambiguousWide: boolean

  /** displayRows × columns 字符网格 */
  screen: string[][] = []

  writes: string[] = []

  /** 宽字符尾随单元占位符（读屏时剔除），使宽字形只在网格里占 1 个可读字符。 */
  private static readonly WIDE_PAD = '\u0000'

  constructor(columns: number, rows: number, opts: { ambiguousWide?: boolean } = {}) {
    this.columns = columns
    this.rows = rows
    this.ambiguousWide = opts.ambiguousWide ?? false
    this.clearScreen()
  }

  /** 单个字符的终端显示宽度（与生产 displayWidth 同口径，box/block 恒为 1）。 */
  private charWidth(ch: string): number {
    return displayWidth(ch, { ambiguousAsWide: this.ambiguousWide })
  }

  private clearScreen(): void {
    this.screen = Array.from({ length: this.rows }, () => Array(this.columns).fill(' '))
  }

  /** 获取屏幕上某行的纯文本（剔除宽字符占位符，去尾部空格，去 ANSI 转义序列）。 */
  getRow(row: number): string {
    if (row < 0 || row >= this.rows) return ''
    const raw = this.screen[row]!.join('').split(ScreenTerminal.WIDE_PAD).join('').replace(/ +$/, '')
    return this.stripAnsi(raw)
  }

  /** 获取从某行开始的所有非空行文本（已去 ANSI 与宽字符占位符）。 */
  getRowsFrom(startRow: number): string[] {
    const result: string[] = []
    for (let r = startRow; r < this.rows; r++) {
      const text = this.stripAnsi(this.screen[r]!.join('').split(ScreenTerminal.WIDE_PAD).join(''))
      if (text.trim() === '') continue
      result.push(text)
    }
    return result
  }

  /** 去除 ANSI CSI/SGR 转义序列。 */
  private stripAnsi(s: string): string {
    return s.replace(/\x1B\[[0-9;]*[a-zA-Z]/g, '')
  }

  /** 光标处写一个字符（仿真实终端 pending-wrap：到达最后一列不立即 wrap，下一字符才
   *  wrap，不丢字符）。宽字形（CJK / ambiguousWide 下的 — … ↑↓ ·）占 2 列：
   *  首列写字形、次列写占位符；放不下行尾 1 列时整体折到下一行。 */
  private putChar(ch: string): void {
    const w = Math.max(1, this.charWidth(ch))
    // pending-wrap：光标已在/越过右边界 → 先折行再写。
    if (this.cursorCol >= this.columns) {
      this.cursorRow++
      this.cursorCol = 0
    }
    // 宽字符放不下当前行最后 1 列 → 整体折到下一行（真实终端行为）。
    if (w === 2 && this.cursorCol === this.columns - 1) {
      this.cursorRow++
      this.cursorCol = 0
    }
    if (this.cursorRow >= this.rows) return
    this.screen[this.cursorRow]![this.cursorCol] = ch
    if (w === 2 && this.cursorCol + 1 < this.columns) {
      this.screen[this.cursorRow]![this.cursorCol + 1] = ScreenTerminal.WIDE_PAD
    }
    this.cursorCol += w
  }

  flush(): string {
    const s = this.writes.join('')
    this.writes = []
    return s
  }

  write = (chunk: string): boolean => {
    this.writes.push(chunk)
    let i = 0
    while (i < chunk.length) {
      const ch = chunk[i]!

      // CSI 序列
      if (ch === '\x1B' && chunk[i + 1] === '[') {
        let j = i + 2
        let isPrivate = false
        if (chunk[j] === '?') { isPrivate = true; j++ }
        let params = ''
        while (j < chunk.length && /[0-9;]/.test(chunk[j]!)) { params += chunk[j]; j++ }
        const final = chunk[j]
        const n = params === '' ? 1 : parseInt(params.split(';')[0]!, 10)

        if (!isPrivate) {
          switch (final) {
            case 'A': this.cursorRow = Math.max(0, this.cursorRow - n); break
            case 'B': this.cursorRow = Math.min(this.rows - 1, this.cursorRow + n); break
            case 'G': this.cursorCol = Math.max(0, n - 1); break
            case 'J': {
              // Erase in Display
              if (n === 0 || params === '') {
                // Erase from cursor to end of screen
                this.eraseFromCursor()
              } else if (n === 2) {
                // Erase entire screen
                this.clearScreen()
              }
              break
            }
            case 'K': {
              // Erase in Line
              if (n === 2 || params === '' || params === '0') {
                this.eraseLine()
              }
              break
            }
            case 'm': break // SGR (color) — 不占屏，忽略
            default: break
          }
        }
        i = j + 1
        continue
      }

      if (ch === '\n') {
        this.cursorRow++
        this.cursorCol = 0
        i++
        continue
      }
      if (ch === '\r') {
        this.cursorCol = 0
        i++
        continue
      }

      // 可打印字符
      this.putChar(ch)
      i++
    }
    return true
  }

  /** 从光标处擦到屏末（ERASE_SCREEN_END）。 */
  private eraseFromCursor(): void {
    // 先擦当前行从光标列到行尾
    for (let c = this.cursorCol; c < this.columns; c++) {
      this.screen[this.cursorRow]![c] = ' '
    }
    // 再擦下面所有行
    for (let r = this.cursorRow + 1; r < this.rows; r++) {
      for (let c = 0; c < this.columns; c++) {
        this.screen[r]![c] = ' '
      }
    }
  }

  /** 擦除当前整行（ERASE_LINE）。 */
  private eraseLine(): void {
    for (let c = 0; c < this.columns; c++) {
      this.screen[this.cursorRow]![c] = ' '
    }
  }
}

function asStdout(term: ScreenTerminal): WriteStream {
  return term as unknown as WriteStream
}

function lines(...texts: string[]): LiveRegionLine[] {
  return texts.map(text => ({ text }))
}

// ── 探针：stringWidth 对含 ANSI 码的文本计算是否准确 ──────────
// 这是根因假设 A 的直接验证。

test('探针: stringWidth 对含 ANSI 码的 CJK 混合文本计算正确', () => {
  const term = new ScreenTerminal(120, 40)
  const engine = new LiveEngine({ stdout: asStdout(term), reservedRows: 0, maxRows: 20 })

  // 模拟真实 topBorder — 含 ╭、天枢(CJK)、ANSI 色码、(main)、┬、v4-pro 等
  const color = (s: string, code: string): string => `\x1B[38;5;${code}m${s}\x1B[39m`
  const topBorder =
    color('╭', '140') +
    color('──', '140') +
    color('天枢', '140') +
    ' ' +
    color('(main)', '100') +
    color('─'.repeat(20), '140') +
    color('┬', '140') +
    color('─'.repeat(20), '140') +
    color('v4-pro', '100') +
    '  ' +
    color('⚡0%', '100') +
    '  ' +
    color('◧6k/1.0M', '100') +
    '  ' +
    color('2s', '100') +
    color('──', '140') +
    color('╮', '140')

  const inputLine = color('│', '140') + ' ' + color('〉', '2') + ' ' + color('█', '4') + color('询问任何事', '100') + '                    ' + color('│', '140')
  const botBorder = color('╰', '140') + color('─'.repeat(118), '140') + color('╯', '140')

  // 首帧渲染
  engine.render(lines(topBorder, inputLine, botBorder))
  const afterFirst = term.getRowsFrom(0).join('\n')
  term.flush()

  // 第二帧：仅 elapsed 变化（2s → 21s）
  const topBorder2 =
    color('╭', '140') +
    color('──', '140') +
    color('天枢', '140') +
    ' ' +
    color('(main)', '100') +
    color('─'.repeat(20), '140') +
    color('┬', '140') +
    color('─'.repeat(20), '140') +
    color('v4-pro', '100') +
    '  ' +
    color('⚡0%', '100') +
    '  ' +
    color('◧6k/1.0M', '100') +
    '  ' +
    color('21s', '100') +  // ← elapsed 变化
    color('──', '140') +
    color('╮', '140')

  // 第二帧渲染 —— 先检查 rowsForLine
  const rowsCount = engine['rowsForLine'](topBorder)

  engine.render(lines(topBorder2, inputLine, botBorder))
  const afterSecond = term.getRowsFrom(0).join('\n')

  // 断言：第二帧不应残留第一帧的 "2s"
  const count2s = (afterSecond.match(/2s/g) || []).length
  const count21s = (afterSecond.match(/21s/g) || []).length

  // 第二帧后屏幕应只有 "21s"，不应有 "2s"
  assert.equal(count2s, 0, `屏幕残留第一帧的 "2s" (count=${count2s}) — 顶框擦除不完整`)
  assert.ok(count21s >= 1, `第二帧的 "21s" 应出现在屏幕上 (count=${count21s})`)

  // 同时断言只有一组边框（只有一个 ╭）
  const tulCornerCount = afterSecond.split('╭').length - 1
  assert.equal(tulCornerCount, 1, `╭ 出现 ${tulCornerCount} 次，预期 1 次 — 多帧边框重叠`)
})

// ── 场景：快速连续渲染（模拟 rapid input/ticker）─────────────

test('连续 10 帧快速渲染不产生 border 残留', () => {
  const term = new ScreenTerminal(120, 40)
  const engine = new LiveEngine({ stdout: asStdout(term), reservedRows: 0, maxRows: 20 })

  const color = (s: string, code: string): string => `\x1B[38;5;${code}m${s}\x1B[39m`
  for (let tick = 0; tick < 10; tick++) {
    const elapsed = `${tick}s`
    const topBorder =
      color('╭', '140') +
      color('──', '140') +
      color('天枢', '140') +
      ' ' +
      color('(main)', '100') +
      color('─'.repeat(10), '140') +
      color('┬', '140') +
      color('─'.repeat(10), '140') +
      color(`elapsed=${elapsed}`, '100') +
      color('──', '140') +
      color('╮', '140')
    engine.render(lines(topBorder, color('│ 〉 █', '140') + '                    ' + color('│', '140')))
  }

  const screen = term.getRowsFrom(0).join('\n')
  // 只应出现一次边框
  const tulCount = screen.split('╭').length - 1
  assert.equal(tulCount, 1, `10 帧后 ╭ 出现 ${tulCount} 次，预期 1 次 — 帧间擦除失效导致残留`)

  // 应只出现最后一帧的 elapsed 值
  assert.ok(screen.includes('elapsed=9s'), '屏幕应包含最后一帧的 elapsed=9s')
  for (let tick = 0; tick < 9; tick++) {
    assert.ok(!screen.includes(`elapsed=${tick}s`), `屏幕不应残留旧帧的 elapsed=${tick}s`)
  }
})

// ── 场景：空值 placeholder 帧 → 有输入帧切换 ─────────────────

test('placeholder 帧到有输入帧切换，不残留 placeholder 边框', () => {
  const term = new ScreenTerminal(120, 40)
  const engine = new LiveEngine({ stdout: asStdout(term), reservedRows: 0, maxRows: 20 })

  const color = (s: string, code: string): string => `\x1B[38;5;${code}m${s}\x1B[39m`

  // Frame 1: placeholder (空输入)
  const topBorder1 =
    color('╭──天枢 (main)──┬──v4-pro──╮', '140')
  const placeHolderLine = color('│', '140') + ' ' + color('〉', '2') + ' ' + color('█询问任何事，或 / 唤起命令', '100') + ' ' + color('│', '140')
  engine.render(lines(topBorder1, placeHolderLine))

  // Frame 2: 用户输入了文字
  const topBorder2 =
    color('╭──天枢 (main)──┬──v4-pro──╮', '140')
  const inputLine = color('│', '140') + ' ' + color('〉', '2') + ' ' + 'hello world' + color('█', '4') + ' ' + color('│', '140')
  engine.render(lines(topBorder2, inputLine))

  const screen = term.getRowsFrom(0).join('\n')
  const tulCount = screen.split('╭').length - 1
  assert.equal(tulCount, 1, `╭ 出现 ${tulCount} 次，预期 1 次`)

  // placeholder 文本不应残留
  assert.ok(!screen.includes('询问任何事'), 'placeholder 不应残留在新帧中')
  assert.ok(screen.includes('hello world'), '新帧内容应出现')
})

// ── 场景：slash 命令触发行数变化（走 buildFullRewrite）──────

test('slash 命令输入导致行数变化，不残留旧顶框', () => {
  const term = new ScreenTerminal(120, 40)
  const engine = new LiveEngine({ stdout: asStdout(term), reservedRows: 0, maxRows: 20 })

  const color = (s: string, code: string): string => `\x1B[38;5;${code}m${s}\x1B[39m`
  const borderNormal = '140'
  const borderSlash = '4'

  const top1 = color('╭', borderNormal) + color('──天枢 (main)──┬──v4-pro──╮', borderNormal)
  const bot1 = color('╰' + '─'.repeat(118) + '╯', borderNormal)
  engine.render(lines(top1, color('│ 〉 █placeholder', borderNormal), bot1))
  term.flush()

  const top2 = color('╭', borderSlash) + color('──天枢 (main)──┬──v4-pro──╮', borderSlash)
  const input2 = color('│', borderSlash) + ' ' + color('〉', '2') + ' ' + '/help' + color('█', '4') + ' ' + color('│', borderSlash)
  const bot2 = color('╰' + '─'.repeat(118) + '╯', borderSlash)
  const hint1 = color('  /help', '100') + '  ' + color('显示帮助信息', '100')
  const hint2 = color('  /clear', '100') + ' ' + color('清屏', '100')
  const hint3 = color('  /model', '100') + ' ' + color('切换模型', '100')

  engine.render(lines(top2, input2, bot2, hint1, hint2, hint3))

  const screen = term.getRowsFrom(0).join('\n')
  const tulCount = screen.split('╭').length - 1
  assert.equal(tulCount, 1, `slash 触发后 ╭ 出现 ${tulCount} 次，预期 1 次 — buildFullRewrite 擦除不完整`)

  // slash hints 应出现
  assert.ok(screen.includes('/help'), 'slash hint /help 应出现')
  assert.ok(screen.includes('/clear'), 'slash hint /clear 应出现')
})

// ── 场景：slash 输入逐字符增长（连续行数变化）─────────────

test('slash 逐字符输入不产生 ghost 累积', () => {
  const term = new ScreenTerminal(120, 40)
  const engine = new LiveEngine({ stdout: asStdout(term), reservedRows: 0, maxRows: 20 })

  const color = (s: string, code: string): string => `\x1B[38;5;${code}m${s}\x1B[39m`
  const borderSlash = '4'

  // 逐帧模拟：空 → / → /h → /he → /hel → /help
  const steps = ['', '/', '/h', '/he', '/hel', '/help']
  for (const val of steps) {
    const isSlash = val.startsWith('/') && !val.includes(' ')
    const bc = isSlash ? borderSlash : '140'
    const top = color('╭──天枢──┬──v4-pro──╮', bc)
    const input = color('│', bc) + ' ' + color('〉', '2') + ' ' + val + color('█', '4') + ' ' + color('│', bc)
    const bot = color('╰' + '─'.repeat(116) + '╯', bc)

    const allLines = [top, input, bot]
    if (isSlash && !val.includes(' ')) {
      allLines.push(color('  /help  帮助', '100'))
      allLines.push(color('  /clear 清屏', '100'))
    }
    engine.render(lines(...allLines))
  }

  const screen = term.getRowsFrom(0).join('\n')
  const tulCount = screen.split('╭').length - 1
  assert.equal(tulCount, 1, `逐字符 slash 输入后 ╭ 出现 ${tulCount} 次，预期 1 次`)

  // 最后一帧是 /help 的 slash 态
  assert.ok(screen.includes('/help'), '最后一帧应含 /help hint')
})

// ── 场景：CJK/ambiguous-wide 终端 — 含 — … · 的提示行实际换行成 2 行 ──────
// 这是用户报告的「交付后输入框换行重叠」的精确复现：动态行含 East-Asian
// Ambiguous 符号（终端按 2 列渲染），string-width 按 1 列计 → rowsForLine 低估
// → buildFullRewrite 回顶欠擦 → 旧帧顶框泄漏。修复后 rowsForLine 按 wide 度量
// （RIVET_AMBIGUOUS_WIDTH=wide）与终端一致，重影消失。
// 升级后的 ScreenTerminal 按显示宽度推进光标，故能复现该换行错位。

test('ambiguous-wide 终端下含 — … · 的提示行（窄计=列宽/宽计>列宽）换行不残留旧顶框', () => {
  const prev = process.env.RIVET_AMBIGUOUS_WIDTH
  process.env.RIVET_AMBIGUOUS_WIDTH = 'wide'
  try {
    const cols = 40
    const term = new ScreenTerminal(cols, 30, { ambiguousWide: true })
    const engine = new LiveEngine({ stdout: asStdout(term), reservedRows: 0, maxRows: 20 })
    const color = (s: string, c: string): string => `\x1B[38;5;${c}m${s}\x1B[39m`

    // 含 — … · 三个 ambiguous 符号：窄计 = cols（1 行），宽计 > cols（终端换行成 2 行）。
    const filler = 'c'.repeat(cols - 15)
    const widish = '  /x — a … b · ' + filler
    assert.equal(displayWidth(widish), cols, '锚定：窄计应等于列宽')
    assert.ok(displayWidth(widish, { ambiguousAsWide: true }) > cols, '锚定：宽计应超过列宽（终端换行）')

    const top = color('╭──天枢──┬──glm──╮', '140')
    const input = color('│ 〉 █ │', '140')
    const bot = color('╰' + '─'.repeat(cols - 2) + '╯', '140')
    const hint2 = color('  /y hint2', '100')
    const hint3 = color('  /z hint3', '100')

    // Frame A：2 行提示（widish 在终端占 2 显示行）
    engine.render(lines(top, input, bot, widish, hint2))
    term.flush()
    // Frame B：3 行提示 → 行数变化 → buildFullRewrite，回顶量依赖 widish 被算作 2 行
    engine.render(lines(top, input, bot, widish, hint2, hint3))

    const screen = term.getRowsFrom(0).join('\n')
    const tulCount = screen.split('╭').length - 1
    assert.equal(tulCount, 1, `ambiguous 行换行后 ╭ 出现 ${tulCount} 次，预期 1 次 — rowsForLine 低估导致重影`)
    assert.ok(screen.includes('hint3'), 'Frame B 的 hint3 应出现')
  } finally {
    if (prev === undefined) delete process.env.RIVET_AMBIGUOUS_WIDTH
    else process.env.RIVET_AMBIGUOUS_WIDTH = prev
  }
})

// ── 探针：升级后的 ScreenTerminal 确实把宽字符建模为 2 列、宽行折行 ───────
test('探针: ScreenTerminal 按显示宽度推进光标（CJK 占 2 列、超宽行折行）', () => {
  const term = new ScreenTerminal(10, 5, { ambiguousWide: true })
  // 写 6 个 CJK（每个 2 列）= 12 列 > 10 → 折到第二行
  term.write('天枢天枢天枢')
  assert.equal(term.getRow(0), '天枢天枢天', '首行容纳 5 个 CJK（10 列）')
  assert.equal(term.getRow(1), '枢', '第 6 个 CJK 折到第二行')
})
