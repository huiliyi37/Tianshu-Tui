/**
 * T9 overlay 交互导航测试（P1-1）。
 *
 * Bug：overlay 激活时仅 Esc 关闭，pager 不能翻页、palette 不能选 →
 * overlay 形同只读弹窗。
 *
 * 契约（经真实 stdin 序列 + 渲染输出验证）：
 *  - pager：j/↓/PgDn 下翻，k/↑ 上翻，Home/End 首末页，越界 clamp，q 关闭
 *  - command-palette：↑/↓ 循环移动选中，Enter 执行回调并关闭，q 关闭
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { ReadStream, WriteStream } from 'node:tty'
import { TuiApp } from '../app.js'

class MockOut {
  columns = 80
  rows = 24
  chunks: string[] = []
  write = (s: string): boolean => { this.chunks.push(s); return true }
  on(): this { return this }
  removeListener(): this { return this }
  clear() { this.chunks = [] }
}
class MockIn {
  isTTY = true
  dataHandler: ((d: string) => void) | null = null
  setRawMode(): this { return this }
  resume(): this { return this }
  setEncoding(): this { return this }
  on(ev: string, h: (d: string) => void): this { if (ev === 'data') this.dataHandler = h; return this }
  removeAllListeners(): this { return this }
  pause(): this { return this }
}

function makeApp() {
  const out = new MockOut()
  const stdin = new MockIn()
  const app = new TuiApp({
    stdout: out as unknown as WriteStream,
    stdin: stdin as unknown as ReadStream,
    cols: 80, rows: 24, modelName: 'test',
  })
  return { app, out, stdin }
}

const stripAnsi = (s: string) => s.replace(/\x1B\[[0-9;?]*[a-zA-Z]/g, '')

// OverlayEngine 用行级 diff 渲染（commit 76da3ee4）：只重写变化的行，未变行不再吐出。
// MockOut 仅累积「写入」，无法表达「未变行仍留在屏上」。此函把 alt-screen 写入流
// （cursorTo / ERASE_LINE / 文本 / 换行）回放到虚拟行网格，还原当前屏幕真实内容——
// 用于需要断言「过滤后屏上还剩哪些行」的搜索型 overlay。
function reconstructScreen(raw: string): string {
  const grid: string[] = []
  let row = 0 // 0-based
  const ensure = (r: number) => { row = r; while (grid.length <= row) grid.push('') }
  ensure(0)
  let i = 0
  while (i < raw.length) {
    if (raw[i] === '\x1B' && raw[i + 1] === '[') {
      const m = /^\x1B\[([0-9;?]*)([a-zA-Z])/.exec(raw.slice(i))
      if (m) {
        const cmd = m[2]
        if (cmd === 'H') {
          const r = parseInt((m[1] || '1').split(';')[0] || '1', 10)
          ensure(Math.max(1, r) - 1)
        } else if (cmd === 'K') {
          grid[row] = '' // ERASE_LINE：清当前行；随后同行写入即新内容
        }
        // 其余控制序列（SGR 'm'、?h/?l 同步/alt-screen/隐藏光标）忽略
        i += m[0].length
        continue
      }
    }
    const ch = raw[i]!
    if (ch === '\n') ensure(row + 1)
    else if (ch !== '\r') grid[row] += ch
    i++
  }
  return grid.join('\n')
}
// rows=24 → pageSize = 24-4 = 20。100 行 → 5 页（0..4）。
const longContent = Array.from({ length: 100 }, (_, i) => `LN${i}`).join('\n')

// 序列：方向键/翻页是完整 ANSI 序列，立即派发（非 lone-ESC，不走 40ms 计时）。
const SEQ: Record<string, string> = {
  down: '\x1B[B', up: '\x1B[A', pagedown: '\x1B[6~', pageup: '\x1B[5~',
  home: '\x1B[H', end: '\x1B[F', enter: '\r', escape: '\x1B',
}

test('pager: ↓/j/PgDn 下翻，k 上翻，越界 clamp', () => {
  const { app, out, stdin } = makeApp()
  app.registerOverlays({ pagerContent: () => ({ content: longContent, page: 0 }) })
  app.activateOverlay('pager')

  const press = (k: string) => { out.clear(); stdin.dataHandler!(SEQ[k] ?? k) }
  const visible = () => stripAnsi(out.chunks.join(''))

  press('down'); assert.ok(visible().includes('LN20'), '↓ → 第 1 页含 LN20')
  press('j'); assert.ok(visible().includes('LN40'), 'j → 第 2 页含 LN40')
  press('pagedown'); assert.ok(visible().includes('LN60'), 'PgDn → 第 3 页含 LN60')
  press('k'); assert.ok(visible().includes('LN40'), 'k → 回第 2 页含 LN40')
  press('end'); assert.ok(visible().includes('LN80'), 'End → 末页含 LN80')
  // 末页再下翻 = no-op（不 rerender，输出为空）；随后 up 应回到第 3 页(LN60)，
  // 证明 down 没把 page 推过 4。
  press('down'); assert.equal(visible().trim(), '', '末页再下翻 no-op（不 rerender）')
  press('up'); assert.ok(visible().includes('LN60'), 'clamp 生效：末页 down 后 up 回第 3 页(LN60)')
  press('home'); assert.ok(visible().includes('LN0') && visible().includes('LN19'), 'Home → 首页含 LN0..LN19')
  // 首页再上翻 = no-op；随后 down 应到第 1 页(LN20)，证明 up 没把 page 推到负。
  press('up'); assert.equal(visible().trim(), '', '首页再上翻 no-op（不 rerender）')
  press('down'); assert.ok(visible().includes('LN20'), 'clamp 生效：首页 up 后 down 到第 1 页(LN20)')
})

test('pager: / 进入搜索，n/N 跳转匹配，Esc 清除', () => {
  const { app, out, stdin } = makeApp()
  app.registerOverlays({
    pagerContent: () => ({
      content: 'alpha\nbeta\ngamma\ndelta',
      page: 0,
      messages: [
        { startLine: 0, endLine: 1, role: 'assistant', summary: 'alpha', lines: ['alpha'], isTruncated: false, rawContent: 'alpha' },
        { startLine: 1, endLine: 2, role: 'assistant', summary: 'beta', lines: ['beta'], isTruncated: false, rawContent: 'beta' },
        { startLine: 2, endLine: 3, role: 'assistant', summary: 'gamma', lines: ['gamma'], isTruncated: false, rawContent: 'gamma' },
        { startLine: 3, endLine: 4, role: 'assistant', summary: 'delta', lines: ['delta'], isTruncated: false, rawContent: 'delta' },
      ],
    }),
  })
  app.activateOverlay('pager')
  // 行级 diff 渲染：跳转匹配仅重写高亮变化的行，故用屏幕重建读「当前屏」而非累积写入。
  const press = (k: string) => stdin.dataHandler!(SEQ[k] ?? k)
  const visible = () => reconstructScreen(out.chunks.join(''))

  press('/'); assert.ok(visible().includes('搜索'))
  press('a'); assert.ok(visible().includes('"a"'))
  // beta 与 delta 都含 'a'；首次匹配 beta（索引 1）
  press('n'); assert.ok(visible().includes('beta'), 'n 跳转到下一处匹配')
  press('n'); assert.ok(visible().includes('delta'), 'n 循环到 delta')
  press('N'); assert.ok(visible().includes('beta'), 'N 回退到 beta')
  press('escape'); assert.ok(visible().includes('查看'), 'Esc 清除搜索回到 page 模式')
})

test('pager: m 进入消息视图，j/k 切换消息', () => {
  const { app, out, stdin } = makeApp()
  app.registerOverlays({
    pagerContent: () => ({
      content: 'first\nsecond',
      page: 0,
      messages: [
        { startLine: 0, endLine: 1, role: 'assistant', summary: 'first', lines: ['first'], isTruncated: false, rawContent: 'first' },
        { startLine: 1, endLine: 2, role: 'assistant', summary: 'second', lines: ['second'], isTruncated: false, rawContent: 'second' },
      ],
    }),
  })
  app.activateOverlay('pager')
  const press = (k: string) => { out.clear(); stdin.dataHandler!(SEQ[k] ?? k) }
  const visible = () => stripAnsi(out.chunks.join(''))

  press('m'); assert.ok(visible().includes('消息 1/2'))
  press('down'); assert.ok(visible().includes('消息 2/2'))
  press('up'); assert.ok(visible().includes('消息 1/2'))
  press('escape'); assert.ok(!visible().includes('返回'), 'Esc 退出消息视图（消息模式 footer 的「返回」消失）')
})

test('command-palette: ↑/↓ 循环选中，Enter 执行回调并关闭', () => {
  const { app, stdin } = makeApp()
  let executed = -1
  app.registerOverlays(
    { paletteCommands: () => ({ commands: [{ label: 'aa' }, { label: 'bb' }, { label: 'cc' }], selectedIndex: 0 }) },
    (idx) => { executed = idx },
  )
  app.activateOverlay('command-palette')
  const press = (k: string) => stdin.dataHandler!(SEQ[k] ?? k)

  press('down'); press('down') // 0 → 2
  press('up')                  // 2 → 1
  press('enter')
  assert.equal(executed, 1, 'Enter 执行选中索引 1（↓↓↑ = 1）的命令')
})

test('command-palette: ↓ 循环到末再回 0', () => {
  const { app, stdin } = makeApp()
  let executed = -1
  app.registerOverlays(
    { paletteCommands: () => ({ commands: [{ label: 'aa' }, { label: 'bb' }], selectedIndex: 0 }) },
    (idx) => { executed = idx },
  )
  app.activateOverlay('command-palette')
  const press = (k: string) => stdin.dataHandler!(SEQ[k] ?? k)
  press('down'); press('down') // 0→1→0（循环）
  press('enter')
  assert.equal(executed, 0, '2 项列表 ↓↓ 循环回 0')
})

test('q 在 overlay 内关闭', async () => {
  const { app, out, stdin } = makeApp()
  app.registerOverlays({ pagerContent: () => ({ content: longContent, page: 0 }) })
  app.activateOverlay('pager')
  out.clear()
  stdin.dataHandler!('q')
  await new Promise(r => setTimeout(r, 10))
  // 关闭后退出 alt-screen（ALT_SCREEN_OFF = \x1B[?1049l）
  assert.ok(out.chunks.join('').includes('\x1B[?1049l'), 'q 关闭 overlay（退出 alt-screen）')
})

// ── T1：搜索型 overlay 实时过滤 ──────────────────────────────
// SEQ.backspace = DEL(0x7f)；字母直接当 data 送入。
const typeKey = (stdin: MockIn, ch: string) => stdin.dataHandler!(ch)

test('command-palette: 字符输入实时过滤 + selectedIndex 复位 + Enter 执行过滤后索引', () => {
  const { app, stdin } = makeApp()
  const all = [{ label: '/foo' }, { label: '/bar' }, { label: '/baz' }]
  const filter = () => {
    const q = app.getOverlayQuery()
    return q ? all.filter(c => c.label.includes(q)) : all
  }
  let executed = ''
  app.registerOverlays(
    { paletteCommands: () => ({ commands: filter(), selectedIndex: 0 }) },
    (idx) => { executed = filter()[idx]?.label ?? '' },
  )
  app.activateOverlay('command-palette')

  typeKey(stdin, 'b')              // query 'b' → [/bar, /baz]，index 0
  stdin.dataHandler!('\x1B[B')     // ↓ → index 1 (/baz)
  typeKey(stdin, 'a')              // query 'ba' → [/bar, /baz] 仍 2 项 → index 复位 0
  assert.equal(app.getOverlayQuery(), 'ba', '查询串累积为 ba')
  stdin.dataHandler!('\r')         // Enter
  assert.equal(executed, '/bar', 'index 复位 0 → Enter 执行过滤后第 0 项 /bar')
})

test('command-palette: 过滤后 Enter 映射到正确命令（display 与 exec 同源）', () => {
  const { app, stdin } = makeApp()
  const all = [{ label: '/alpha' }, { label: '/beta' }, { label: '/gamma' }]
  const filter = () => {
    const q = app.getOverlayQuery()
    return q ? all.filter(c => c.label.includes(q)) : all
  }
  let executed = ''
  app.registerOverlays(
    { paletteCommands: () => ({ commands: filter(), selectedIndex: 0 }) },
    (idx) => { executed = filter()[idx]?.label ?? '' },
  )
  app.activateOverlay('command-palette')
  // 输入 'g' → 仅 [/gamma]；未过滤时 /gamma 在 index 2，过滤后应在 index 0。
  typeKey(stdin, 'g')
  stdin.dataHandler!('\r')
  assert.equal(executed, '/gamma', '过滤后 index 0 = /gamma（不会错位到未过滤的 index 0）')
})

test('command-palette: q 是查询字符而非关闭（仅 Esc/全局关闭）', async () => {
  const { app, out, stdin } = makeApp()
  app.registerOverlays({ paletteCommands: () => ({ commands: [{ label: '/quit' }], selectedIndex: 0 }) })
  app.activateOverlay('command-palette')
  out.clear()
  typeKey(stdin, 'q')
  await new Promise(r => setTimeout(r, 10))
  assert.equal(app.getOverlayQuery(), 'q', 'q 进入查询串')
  assert.ok(!out.chunks.join('').includes('\x1B[?1049l'), 'q 未关闭 palette（未退出 alt-screen）')
})

test('command-palette: backspace 删除查询尾字符', () => {
  const { app, stdin } = makeApp()
  app.registerOverlays({ paletteCommands: () => ({ commands: [], selectedIndex: 0 }) })
  app.activateOverlay('command-palette')
  typeKey(stdin, 'b'); typeKey(stdin, 'a')
  assert.equal(app.getOverlayQuery(), 'ba')
  stdin.dataHandler!('\x7f')       // DEL → backspace
  assert.equal(app.getOverlayQuery(), 'b', 'backspace 删一字符')
})

test('history-search: 字符过滤渲染列表 + 查询回显 + Enter 回填输入', () => {
  const { app, out, stdin } = makeApp()
  const all = ['git status', 'npm test', 'git log']
  app.registerOverlays({
    historySearchData: () => {
      const q = app.getOverlayQuery().toLowerCase()
      const entries = q ? all.filter(e => e.toLowerCase().includes(q)) : all
      return { entries, selectedIndex: 0, query: app.getOverlayQuery() }
    },
  })
  app.activateOverlay('history-search')
  // 行级 diff 渲染：过滤后未变的行（如首项 git status）不再吐出，故用屏幕重建读「当前屏」。
  const screen = () => reconstructScreen(out.chunks.join(''))

  typeKey(stdin, 'g'); typeKey(stdin, 'i'); typeKey(stdin, 't')   // query 'git'
  assert.equal(app.getOverlayQuery(), 'git')
  assert.ok(screen().includes('git status') && screen().includes('git log'), '过滤后列表含 git 项')
  assert.ok(!screen().includes('npm test'), '过滤掉 npm test')
  assert.ok(screen().includes('git'), '查询串回显')

  stdin.dataHandler!('\r')         // Enter → 回填第 0 项
  assert.equal(app.getInputValue(), 'git status', 'Enter 回填过滤后第 0 项到输入框')
})

test('toggleVim 切换 vim 键位并返回新状态', () => {
  const { app } = makeApp()
  assert.equal(app.isVimEnabled(), false, '默认关闭 vim')
  assert.equal(app.toggleVim(), true, 'toggle → on 返回 true')
  assert.equal(app.isVimEnabled(), true)
  assert.equal(app.toggleVim(), false, 'toggle → off 返回 false')
  assert.equal(app.isVimEnabled(), false)
})

test('tasks overlay: register + activate 渲染 per-worker 舰队', () => {
  const { app, out } = makeApp()
  app.registerOverlays({
    tasksData: () => ({
      groups: [{
        parentToolId: 'tool_a',
        total: 2,
        done: 1,
        failed: 0,
        running: 1,
        workers: [{
          workerId: 'wo_team:T1',
          shortLabel: 'T1',
          profile: 'code_scout',
          status: 'running',
          activity: '⚙ grep routing seams',
          elapsedMs: 1500,
        }],
      }],
      filter: 'running' as const,
      completedCount: 0,
    }),
  })
  assert.equal(app.activateOverlay('tasks'), true, 'tasks overlay 应成功激活')
  const visible = stripAnsi(out.chunks.join(''))
  assert.ok(visible.includes('子代理任务'), '应显示 tasks 标题')
  assert.ok(visible.includes('code_scout'), '应显示 worker profile')
  assert.ok(visible.includes('T1'), '应显示 worker 短标签')
  assert.ok(visible.includes('1/2 完成'), '应显示组进度')
  assert.ok(visible.includes('grep routing seams'), '应显示活动行')
})

test('fleet 回收：abort 后舰队读模型清空（防中断泄露回归）', () => {
  const { app } = makeApp()
  // 委派工具开始 + 两个 worker 上报 running 活动
  app.callbacks.onToolUse('tool_a', 'delegate_batch', { tasks: [] })
  app.callbacks.onDelegationActivity?.({ workOrderId: 'wo_team:T1', parentToolId: 'tool_a', profile: 'scout', status: 'running', progressLine: '⚙ grep' })
  app.callbacks.onDelegationActivity?.({ workOrderId: 'wo_team:T2', parentToolId: 'tool_a', profile: 'patcher', status: 'running' })
  assert.equal(app.getRunningWorkers().groups.length, 1, 'abort 前应有 1 个活跃委派组')
  // 中断（先 _runGen++，旧 run 的终态 onToolResult 会被 bridge 丢弃）
  app.callbacks.onAbort()
  assert.equal(app.getRunningWorkers().groups.length, 0, 'abort 后舰队读模型必须清空，不得泄露')
})

test('fleet 回收：provider onError 同样清空舰队读模型', () => {
  const { app } = makeApp()
  app.callbacks.onToolUse('tool_b', 'delegate_task', {})
  app.callbacks.onDelegationActivity?.({ workOrderId: 'wo:W1', parentToolId: 'tool_b', profile: 'scout', status: 'running' })
  assert.equal(app.getRunningWorkers().groups.length, 1)
  app.callbacks.onError(new Error('provider blew up'))
  assert.equal(app.getRunningWorkers().groups.length, 0, 'onError 后舰队读模型必须清空')
})
