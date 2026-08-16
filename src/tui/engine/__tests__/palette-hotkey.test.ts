/**
 * 命令面板快捷键契约：Ctrl+P 开关（替代原 Ctrl+Esc）。
 *
 * 背景（换绑理由，三条路全断）：
 *  - Windows 宿主：Ctrl+Esc 被系统抢占（打开开始菜单），按键事件到不了终端；
 *  - 传统转义序列：Ctrl+Esc 与单独 Esc 同码（0x1B），解析层不可区分；
 *  - kitty 增强键盘：Ctrl+Esc 编码 \x1B[27;5u，解析器未映射该码位（unknown）。
 * Ctrl+P 是 0x10 单控制字符，所有终端都能可靠送达。
 *
 * 历史回溯不因此失去入口：单行 ↑/↓、Ctrl+N（下一条）、Ctrl+R 全屏历史搜索；
 * 多行编辑时方向键仍只做行间导航（防误触设计，见 input-line moveUpOrHistory）。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { ReadStream, WriteStream } from 'node:tty'
import { TuiApp } from '../app.js'
import { InputLine } from '../input-line.js'

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

const tick = () => new Promise(r => setTimeout(r, 10))

/** 终端把 Ctrl+P 送达为单控制字节 DLE(0x10)，走真实解析器。 */
const CTRL_P = '\x10'
const ALT_OFF = '\x1B[?1049l'

const activeId = (app: TuiApp) =>
  (app as unknown as { overlay: { activeId(): string | null } }).overlay.activeId()

const inputLineValue = (app: TuiApp) =>
  (app as unknown as { inputLine: { value: string } }).inputLine.value

function registerPalette(app: TuiApp) {
  app.registerOverlays(
    { paletteCommands: () => ({ commands: [{ label: '/x' }, { label: '/y' }], selectedIndex: 0 }) },
    () => {},
  )
}

test('Ctrl+P（0x10）经真实解析器打开命令面板', async () => {
  const { app, stdin } = makeApp()
  registerPalette(app)
  stdin.dataHandler!(CTRL_P)
  await tick()
  assert.equal(activeId(app), 'command-palette', '空闲时 Ctrl+P 激活 command-palette overlay')
})

test('命令面板已开时 Ctrl+P 关闭（toggle）', async () => {
  const { app, out, stdin } = makeApp()
  registerPalette(app)
  app.activateOverlay('command-palette')
  out.clear()
  stdin.dataHandler!(CTRL_P)
  await tick()
  assert.equal(activeId(app), null, '面板开着时 Ctrl+P 关闭')
  assert.ok(out.chunks.join('').includes(ALT_OFF), '关闭时退出 alt-screen')
})

test('其他 overlay 开着时 Ctrl+P 切到命令面板', async () => {
  const { app, stdin } = makeApp()
  registerPalette(app)
  app.activateOverlay('history-search')
  stdin.dataHandler!(CTRL_P)
  await tick()
  assert.equal(activeId(app), 'command-palette', 'history-search 开着时 Ctrl+P 切换到 command-palette')
})

test('Ctrl+P 开面板不打扰输入框草稿（关闭面板后草稿仍在）', async () => {
  const { app, stdin } = makeApp()
  registerPalette(app)
  stdin.dataHandler!('h')
  stdin.dataHandler!('i')
  stdin.dataHandler!(CTRL_P)
  await tick()
  assert.equal(activeId(app), 'command-palette', '草稿存在时也能开面板')
  stdin.dataHandler!('\x1B') // Esc 关面板（overlay 激活时 ESC 立即派发）
  await tick()
  assert.equal(activeId(app), null)
  assert.equal(inputLineValue(app), 'hi', '草稿不被面板吞掉')
})

test('InputLine：Ctrl+P 不再是历史回溯键（↑ 单行仍翻历史）', () => {
  const input = new InputLine({ history: ['prev1'] })
  input.handleKey('ctrl_p', '', true, false)
  assert.equal(input.value, '', 'Ctrl+P 让位给命令面板，InputLine 不响应')
  input.handleKey('up', '', false, false)
  assert.equal(input.value, 'prev1', '单行 ↑ 仍取上一条历史')
})

test('InputLine：Ctrl+N 下一条历史保留（readline 对偶不受影响）', () => {
  const input = new InputLine({ history: ['prev1', 'prev0'] })
  input.handleKey('up', '', false, false)      // → prev1
  input.handleKey('up', '', false, false)      // → prev0
  input.handleKey('ctrl_n', '', true, false)
  assert.equal(input.value, 'prev1', 'Ctrl+N 仍回到下一条历史')
})
