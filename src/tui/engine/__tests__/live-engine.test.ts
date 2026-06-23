/**
 * T9 LiveEngine 重绘协议测试。
 *
 * 阶段 0（复现 RED）+ 阶段 4（协议断言）合一：
 * - 用最小终端模拟器（MockTerminal）忠实重现"live 区贴底时每帧滚动"的卡顿特征。
 * - 断言修复后的协议：不用 SAVE/RESTORE、尾行不带 \n、行级 diff 跳过未变行、CSI 2026 同步输出包裹。
 *
 * 滚屏类 bug 单测难直接覆盖，这里用确定性的终端模拟器把"滚动次数"变成可断言信号。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { WriteStream } from 'node:tty'
import { LiveEngine, type LiveRegionLine } from '../live-engine.js'

/**
 * 最小终端模拟器：追踪光标行 / 滚动次数 / 全部写入字节。
 * 只建模垂直移动与滚动（R1 关注点），擦除/SGR 对滚动无影响，按需忽略。
 */
class MockTerminal {
  columns: number
  rows: number
  cursorRow = 0
  cursorCol = 0
  scrollCount = 0
  private savedRow = 0
  private savedCol = 0
  writes: string[] = []

  constructor(columns: number, rows: number) {
    this.columns = columns
    this.rows = rows
  }

  /** 取出自上次 flush 以来的全部写入字节并清空缓冲。 */
  flush(): string {
    const s = this.writes.join('')
    this.writes = []
    return s
  }

  private lineFeed(): void {
    if (this.cursorRow >= this.rows - 1) {
      this.scrollCount++ // 在底行换行 → 滚屏，光标留在底行
    } else {
      this.cursorRow++
    }
  }

  write = (chunk: string): boolean => {
    this.writes.push(chunk)
    let i = 0
    while (i < chunk.length) {
      const ch = chunk[i]!
      if (ch === '\x1b' && chunk[i + 1] === '[') {
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
            case 's': this.savedRow = this.cursorRow; this.savedCol = this.cursorCol; break
            case 'u': this.cursorRow = this.savedRow; this.cursorCol = this.savedCol; break
            case 'H': {
              const parts = params.split(';')
              this.cursorRow = Math.min(this.rows - 1, Math.max(0, (parseInt(parts[0] || '1', 10)) - 1))
              this.cursorCol = Math.max(0, (parseInt(parts[1] || '1', 10)) - 1)
              break
            }
            case 'G': this.cursorCol = Math.max(0, n - 1); break
            default: break // J / K (erase) 不影响滚动
          }
        }
        // 私有模式 h/l（CSI ?2026h/l 同步输出）忽略
        i = j + 1
        continue
      }
      if (ch === '\n') { this.lineFeed(); i++; continue }
      if (ch === '\r') { this.cursorCol = 0; i++; continue }
      // 可打印字符
      this.cursorCol++
      if (this.cursorCol >= this.columns) {
        this.cursorCol = 0
        this.lineFeed()
      }
      i++
    }
    return true
  }
}

function asStdout(term: MockTerminal): WriteStream {
  return term as unknown as WriteStream
}

function lines(...texts: string[]): LiveRegionLine[] {
  return texts.map(text => ({ text }))
}

// ── R1：贴底重渲不得持续滚屏 ───────────────────────────────────

test('R1: 相同内容重渲多帧，不产生额外滚屏（贴底卡顿复现/修复）', () => {
  // rows=3，live 区 3 行恰好贴底——原协议尾行 \n 会每帧滚屏一次
  const term = new MockTerminal(80, 3)
  const engine = new LiveEngine({ stdout: asStdout(term), reservedRows: 0, maxRows: 20 })

  engine.render(lines('L0', 'L1', 'L2'))
  const scrollAfterFirst = term.scrollCount

  // 模拟 ticker：相同内容重渲 10 帧
  for (let i = 0; i < 10; i++) engine.render(lines('L0', 'L1', 'L2'))

  assert.equal(
    term.scrollCount,
    scrollAfterFirst,
    `相同内容重渲不应继续滚屏（first=${scrollAfterFirst} after10=${term.scrollCount}）`,
  )
})

// ── R1：不使用 SAVE/RESTORE 绝对光标 ───────────────────────────

test('R1: 增量重渲不得使用 SAVE_CURSOR/RESTORE_CURSOR（贴底会错位）', () => {
  const term = new MockTerminal(80, 24)
  const engine = new LiveEngine({ stdout: asStdout(term), reservedRows: 0, maxRows: 20 })

  engine.render(lines('A', 'B', 'C'))
  term.flush()
  engine.render(lines('A', 'B', 'C2'))
  const frame = term.flush()

  assert.ok(!frame.includes('\x1B[s'), '增量帧不应包含 SAVE_CURSOR (\\x1B[s)')
  assert.ok(!frame.includes('\x1B[u'), '增量帧不应包含 RESTORE_CURSOR (\\x1B[u)')
})

// ── R2：行级 diff，未变行不重写 ────────────────────────────────

test('R2: 仅一行变化时，未变行不被重写', () => {
  const term = new MockTerminal(80, 24)
  const engine = new LiveEngine({ stdout: asStdout(term), reservedRows: 0, maxRows: 20 })

  engine.render(lines('STATUS-0', 'GLANCE', 'INPUT'))
  term.flush()
  // 仅状态行变化（模拟 spinner 帧）
  engine.render(lines('STATUS-1', 'GLANCE', 'INPUT'))
  const frame = term.flush()

  assert.ok(frame.includes('STATUS-1'), '变化行应被重写')
  assert.ok(!frame.includes('GLANCE'), '未变行 GLANCE 不应被重写')
  assert.ok(!frame.includes('INPUT'), '未变行 INPUT 不应被重写')
})

// ── H2：无变化短路（内容相同不产生任何写入） ──────────────────

test('H2: 内容与上帧逐行相同时短路，不产生任何 stdout 写入', () => {
  const term = new MockTerminal(80, 24)
  const engine = new LiveEngine({ stdout: asStdout(term), reservedRows: 0, maxRows: 20 })

  engine.render(lines('A', 'B', 'C'))
  term.flush()
  // 完全相同内容重渲
  engine.render(lines('A', 'B', 'C'))
  const frame = term.flush()

  assert.equal(frame, '', '内容未变应短路，零写入')
})

test('H2: 内容变化后正常渲染（短路不影响真实更新）', () => {
  const term = new MockTerminal(80, 24)
  const engine = new LiveEngine({ stdout: asStdout(term), reservedRows: 0, maxRows: 20 })

  engine.render(lines('A', 'B', 'C'))
  term.flush()
  engine.render(lines('A', 'B', 'C')) // 短路
  assert.equal(term.flush(), '')
  engine.render(lines('A', 'B', 'C2')) // 真实变化
  const frame = term.flush()
  assert.ok(frame.includes('C2'), '变化帧应正常渲染')
})

test('H2: clear 后即使内容相同也重新 append（forceRedraw 不被误短路）', () => {
  const term = new MockTerminal(80, 24)
  const engine = new LiveEngine({ stdout: asStdout(term), reservedRows: 0, maxRows: 20 })

  engine.render(lines('A', 'B', 'C'))
  term.flush()
  engine.clear() // 模拟 forceRedraw 的 live.clear()
  term.flush()
  engine.render(lines('A', 'B', 'C')) // 相同内容，但 clear 后必须重画
  const frame = term.flush()
  assert.ok(frame.includes('A') && frame.includes('C'), 'clear 后相同内容必须重新 append，不可短路')
})

// ── H1：wrap 行参与增量 diff（高度不变时不全量重写） ──────────

test('H1: 多行 wrap 行高度不变时走增量 diff（未变 wrap 行不重写）', () => {
  const term = new MockTerminal(40, 24)
  const engine = new LiveEngine({ stdout: asStdout(term), reservedRows: 0, maxRows: 30 })

  // 第一行 90 字符 → 宽 40 时 ceil(90/40)=3 显示行。STATUS 短行 1 显示行。
  const wide = 'W'.repeat(90)
  engine.render(lines('STATUS-0', wide, 'INPUT'))
  term.flush()
  // 仅 STATUS 变化；wide(3行) 与 INPUT 不变，wrap 高度全部不变 → 应走增量。
  engine.render(lines('STATUS-1', wide, 'INPUT'))
  const frame = term.flush()

  assert.ok(frame.includes('STATUS-1'), '变化行应被重写')
  assert.ok(!frame.includes('W'.repeat(90)), '未变的 wrap 行不应被重写')
  assert.ok(!frame.includes('INPUT'), '未变的 INPUT 不应被重写')
  // 增量路径标志：含 cursorUp 回顶，不含全量 ERASE_SCREEN_END 之外仍是增量
  assert.ok(/\x1B\[\d+A/.test(frame) || frame.includes('\x1B[1A') || frame.startsWith('\x1B[?2026h'),
    '应为增量帧（CSI 2026 包裹）')
})

test('H1: 变化的多行 wrap 行被完整擦除续行后重写（不留 ghost）', () => {
  const term = new MockTerminal(40, 24)
  const engine = new LiveEngine({ stdout: asStdout(term), reservedRows: 0, maxRows: 30 })

  const wideA = 'A'.repeat(90) // 3 显示行
  const wideB = 'B'.repeat(90) // 3 显示行（高度相同 → 仍可增量）
  engine.render(lines('TOP', wideA, 'INPUT'))
  term.flush()
  engine.render(lines('TOP', wideB, 'INPUT'))
  const frame = term.flush()

  // 变化的 wrap 行：应对其 3 个显示行各发一次 ERASE_LINE（首行 + 2 续行）
  const eraseCount = (frame.match(/\x1B\[2K/g) || []).length
  assert.ok(eraseCount >= 3, `变化的 3 显示行 wrap 行应擦除全部续行（≥3 次 ERASE_LINE），实际 ${eraseCount}`)
  assert.ok(frame.includes('B'.repeat(90)), '新内容应被写入')
  assert.ok(!frame.includes('TOP'), '未变的 TOP 不应被重写')
})

test('H1: wrap 高度变化时回退全量重写（不走增量）', () => {
  const term = new MockTerminal(40, 24)
  const engine = new LiveEngine({ stdout: asStdout(term), reservedRows: 0, maxRows: 30 })

  const short = 'S'.repeat(30) // 1 显示行
  const grown = 'S'.repeat(90) // 3 显示行（高度变化 → 级联，回退全量）
  engine.render(lines('TOP', short, 'INPUT'))
  term.flush()
  engine.render(lines('TOP', grown, 'INPUT'))
  const frame = term.flush()

  // 全量重写会用 ERASE_SCREEN_END（\x1B[0J）一次性擦到屏末并重写全部行
  assert.ok(frame.includes('\x1B[0J'), 'wrap 高度变化应回退全量重写（含 ERASE_SCREEN_END）')
  assert.ok(frame.includes('TOP'), '全量重写会重写所有行（含 TOP）')
})

// ── R3 / 阶段3：CSI 2026 同步输出包裹增量帧 ─────────────────────

test('阶段3: 增量帧用 CSI 2026 同步输出包裹（防撕裂）', () => {
  const term = new MockTerminal(80, 24)
  const engine = new LiveEngine({ stdout: asStdout(term), reservedRows: 0, maxRows: 20 })

  engine.render(lines('A', 'B', 'C'))
  term.flush()
  engine.render(lines('A2', 'B', 'C'))
  const frame = term.flush()

  assert.ok(frame.startsWith('\x1B[?2026h'), '增量帧应以 BEGIN_SYNC (\\x1B[?2026h) 开头')
  assert.ok(frame.endsWith('\x1B[?2026l'), '增量帧应以 END_SYNC (\\x1B[?2026l) 结尾')
})

// ── 结构变化（行数变化）走全量重写，仍不滚屏/不用 SAVE/RESTORE ──

test('结构变化（行数增减）安全重绘，不滚屏不用 SAVE/RESTORE', () => {
  const term = new MockTerminal(80, 3)
  const engine = new LiveEngine({ stdout: asStdout(term), reservedRows: 0, maxRows: 20 })

  engine.render(lines('L0', 'L1', 'L2'))
  const baseScroll = term.scrollCount
  term.flush()

  // 行数减少
  engine.render(lines('L0', 'L1'))
  let frame = term.flush()
  assert.ok(!frame.includes('\x1B[s') && !frame.includes('\x1B[u'), '不应使用 SAVE/RESTORE')

  // 行数增加
  engine.render(lines('L0', 'L1', 'L2', 'L3'))
  frame = term.flush()
  assert.ok(!frame.includes('\x1B[s') && !frame.includes('\x1B[u'), '不应使用 SAVE/RESTORE')

  // 多帧稳定后不应无限滚屏
  for (let i = 0; i < 5; i++) engine.render(lines('L0', 'L1', 'L2', 'L3'))
  // rows=3 而内容 4 行 > 视口，首帧会滚一次进入稳态；之后相同内容不应继续滚
  const stableScroll = term.scrollCount
  for (let i = 0; i < 5; i++) engine.render(lines('L0', 'L1', 'L2', 'L3'))
  assert.equal(term.scrollCount, stableScroll, '稳态相同内容不应继续滚屏')

  assert.ok(term.scrollCount >= baseScroll)
})

// ── reservedTail：行数超 maxRows 时尾部 chrome（输入框）必须保留 ──

test('reservedTail: 内容超 maxRows 时尾部 chrome 行始终保留（输入框不被截断）', () => {
  const term = new MockTerminal(80, 50)
  const engine = new LiveEngine({ stdout: asStdout(term), reservedRows: 0, maxRows: 5 })

  // 10 行 dynamic（streaming/tools）+ 3 行尾部 chrome（分隔/glance/输入框）
  const all = lines(
    'D0', 'D1', 'D2', 'D3', 'D4', 'D5', 'D6', 'D7', 'D8', 'D9',
    'GLANCE-SEP', 'GLANCE', '▸ INPUT',
  )
  engine.render(all, { reservedTail: 3 })
  const frame = term.flush()

  assert.ok(frame.includes('▸ INPUT'), '输入框必须出现在首帧')
  assert.ok(frame.includes('GLANCE'), 'glance 必须保留')
  assert.ok(frame.includes('D9'), '最近的 dynamic 行应保留')
  assert.ok(!frame.includes('D0'), '最早的 dynamic 行应被截断（让位给尾部 chrome）')
})

test('reservedTail: 尾部 chrome 超过 maxRows 时仍全部显示（宁可超行也要见输入框）', () => {
  const term = new MockTerminal(80, 50)
  const engine = new LiveEngine({ stdout: asStdout(term), reservedRows: 0, maxRows: 2 })

  const all = lines('D0', 'D1', 'GLANCE-SEP', 'GLANCE', '▸ INPUT')
  engine.render(all, { reservedTail: 3 })
  const frame = term.flush()

  assert.ok(frame.includes('▸ INPUT'), '输入框必须出现')
  assert.ok(frame.includes('GLANCE'), 'glance 必须出现')
  assert.ok(frame.includes('GLANCE-SEP'), 'chrome 全部保留')
})

// ── clear / clearForCommit 后回到 append 路径不滚屏 ─────────────

test('clearForCommit 后再渲染走 append 路径，贴底不持续滚屏', () => {
  const term = new MockTerminal(80, 5)
  const engine = new LiveEngine({ stdout: asStdout(term), reservedRows: 0, maxRows: 20 })

  engine.render(lines('L0', 'L1', 'L2'))
  engine.clearForCommit()
  // 模拟 commit 写入 scrollback
  asStdout(term).write('committed line\n')
  engine.render(lines('L0', 'L1', 'L2'))
  const scrollBefore = term.scrollCount
  for (let i = 0; i < 10; i++) engine.render(lines('L0', 'L1', 'L2'))
  assert.equal(term.scrollCount, scrollBefore, 'commit 后稳态重渲不应继续滚屏')
})

// ── resize：宽度变化后增量帧的 cursorUp 必须按「新宽度下缓存内容的行数」回顶 ──
// 根因：render() 用当前 columns 算 rowsForLine，但 lastDisplayRows 是上一帧在
// 旧宽度下存的。终端 resize 会把已绘内容按新宽 reflow，行数变了；若 moveToTop
// 仍用旧 lastDisplayRows，cursorUp 量不足 → reflow 后的顶部行擦不掉 → 多份不同
// 宽度的 chrome/面板叠在 scrollback 里（截图实证：任务面板在三种宽度同屏）。
// 修复：render() 检测 columns 变化，按新宽度从 lineCache 重算 lastDisplayRows 再回顶。
test('resize: 宽度变窄后，增量帧按新宽度的 reflow 行数回顶（不残留旧帧）', () => {
  const term = new MockTerminal(100, 40)
  const engine = new LiveEngine({ stdout: asStdout(term), reservedRows: 0, maxRows: 30 })

  // 一行 90 字符：宽 100 时占 1 显示行
  const wide = 'X'.repeat(90)
  engine.render(lines(wide, 'INPUT'))
  term.flush()

  // 终端变窄到 40：那 90 字符行 reflow 成 ceil(90/40)=3 显示行 → 旧帧实际占 3+1=4 行
  term.columns = 40
  engine.render(lines(wide, 'INPUT2'))
  const frame = term.flush()

  // moveToTop 必须按新宽度回顶（覆盖 reflow 后的 4 行），即 cursorUp(3)（4-1）。
  // 修复前用旧 lastDisplayRows=2 → cursorUp(1)，欠回 2 行 → 残留。
  const upMatch = frame.match(/\x1B\[(\d+)A/)
  assert.ok(upMatch, `增量帧应含 cursorUp：${JSON.stringify(frame)}`)
  const upCount = parseInt(upMatch![1]!, 10)
  assert.ok(
    upCount >= 3,
    `宽度变窄后 cursorUp 应 ≥3（新宽下缓存内容 reflow 行数-1），实际 ${upCount} —— 欠回会残留旧帧`,
  )
})

test('resize: 宽度变化后稳态重渲不持续滚屏且不残留', () => {
  const term = new MockTerminal(100, 10)
  const engine = new LiveEngine({ stdout: asStdout(term), reservedRows: 0, maxRows: 30 })

  const wide = 'Y'.repeat(85)
  engine.render(lines(wide, 'SEP', 'INPUT'))
  term.flush()
  term.columns = 50
  engine.render(lines(wide, 'SEP', 'INPUT'))
  const scrollAfterResize = term.scrollCount
  for (let i = 0; i < 8; i++) engine.render(lines(wide, 'SEP', 'INPUT'))
  assert.equal(term.scrollCount, scrollAfterResize, 'resize 后稳态相同内容不应继续滚屏')
})
