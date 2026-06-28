/**
 * T9 Bash Group Buffer 集成测试 — app.ts 接线。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { ReadStream, WriteStream } from 'node:tty'
import { TuiApp } from '../engine/app.js'

class MockOut {
  columns = 120; rows = 24; chunks: string[] = []
  write = (s: string): boolean => { this.chunks.push(s); return true }
  on(): this { return this }
  removeListener(): this { return this }
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
    cols: 120, rows: 24,
    modelName: 'test',
    contextWindow: 200_000,
  })
  return { app, out }
}

const stripAnsi = (s: string) => s.replace(/\x1B\[[0-9;]*[a-zA-Z]/g, '')

function scrollbackPlain(app: TuiApp): string {
  return stripAnsi(app.getScrollbackContent())
}

/** terminal result */
function tr(app: TuiApp, id: string, name: string, result: string, isError = false) {
  app.callbacks.onToolResult(id, name, result, isError)
}

// ── 基本折叠 ───────────────────────────────────────────────────

test('3 个短 bash 命令折叠为 "Ran 3 shell commands"', () => {
  const { app } = makeApp()

  app.callbacks.onToolUse('b1', 'bash', { command: 'pwd' })
  app.callbacks.onToolUse('b2', 'bash', { command: 'ls' })
  app.callbacks.onToolUse('b3', 'bash', { command: 'whoami' })
  tr(app, 'b1', 'bash', '/home/user')
  tr(app, 'b2', 'bash', 'a.txt\nb.txt')
  tr(app, 'b3', 'bash', 'user')
  // 用一个 write 打断 flush
  app.callbacks.onToolUse('w1', 'write_file', { file_path: 'out.ts' })
  tr(app, 'w1', 'write_file', 'ok')

  const text = scrollbackPlain(app)
  assert.ok(text.includes('Ran 3 shell commands'), `expected summary in: ${text.slice(0, 500)}`)
  assert.ok(text.includes('pwd'), 'should list pwd command')
  assert.ok(text.includes('ls'), 'should list ls command')
  assert.ok(text.includes('whoami'), 'should list whoami command')
})

// ── 变更型 bash 打断折叠 ───────────────────────────────────────

test('变更型 bash 打断前面的可折叠 bash 组', () => {
  const { app } = makeApp()

  app.callbacks.onToolUse('b1', 'bash', { command: 'pwd' })
  app.callbacks.onToolUse('b2', 'bash', { command: 'ls' })
  tr(app, 'b1', 'bash', '/home/user')
  tr(app, 'b2', 'bash', 'a.txt')
  // rm 不可折叠，应 flush 前面 2 条 bash 组，再单独渲染 rm
  app.callbacks.onToolUse('b3', 'bash', { command: 'rm -rf temp' })
  tr(app, 'b3', 'bash', '', false)

  const text = scrollbackPlain(app)
  assert.ok(text.includes('Ran 2 shell commands'), 'first 2 bash should be grouped')
  // rm 应作为独立 tool card 渲染（包含命令摘要）
  assert.ok(text.includes('rm -rf temp'), 'rm command should be rendered individually')
})

// ── 错误命令打断折叠 ───────────────────────────────────────────

test('bash 错误命令把前面成功命令摘要后单独渲染错误卡片', () => {
  const { app } = makeApp()

  app.callbacks.onToolUse('b1', 'bash', { command: 'pwd' })
  app.callbacks.onToolUse('b2', 'bash', { command: 'ls' })
  app.callbacks.onToolUse('b3', 'bash', { command: 'cat missing' })
  tr(app, 'b1', 'bash', '/home/user')
  tr(app, 'b2', 'bash', 'a.txt')
  tr(app, 'b3', 'bash', 'No such file', true)

  const text = scrollbackPlain(app)
  assert.ok(text.includes('Ran 2 shell commands'), 'first 2 success should be grouped')
  assert.ok(text.includes('No such file'), 'error output should be visible')
  assert.ok(text.includes('cat missing'), 'error command should be visible')
})

// ── read/search 与 bash 互相打断 ───────────────────────────────

test('read 工具打断 bash 组，bash 工具打断 read 组', () => {
  const { app } = makeApp()

  app.callbacks.onToolUse('b1', 'bash', { command: 'pwd' })
  tr(app, 'b1', 'bash', '/home/user')
  app.callbacks.onToolUse('r1', 'read_file', { file_path: 'a.ts' })
  tr(app, 'r1', 'read_file', 'content a')
  app.callbacks.onToolUse('b2', 'bash', { command: 'ls' })
  tr(app, 'b2', 'bash', 'b.txt')

  const text = scrollbackPlain(app)
  assert.ok(text.includes('Ran 1 shell command'), 'first bash should be flushed as group')
  assert.ok(text.includes('Read 1 file'), 'read should be flushed as group')
  assert.ok(text.includes('Ran 1 shell command'), 'second bash should be its own group')
})

// ── turn 边界 flush ────────────────────────────────────────────

test('turnComplete 时 flush 残余 bash 折叠组', () => {
  const { app } = makeApp()

  app.callbacks.onToolUse('b1', 'bash', { command: 'pwd' })
  tr(app, 'b1', 'bash', '/home/user')
  app.callbacks.onTurnComplete({ input_tokens: 100, output_tokens: 50 }, 1, true)

  const text = scrollbackPlain(app)
  assert.ok(text.includes('Ran 1 shell command'), 'group should be flushed on turnComplete')
})

// ── abort flush ───────────────────────────────────────────────

test('abort 时 flush 残余 bash 折叠组', () => {
  const { app } = makeApp()

  app.callbacks.onToolUse('b1', 'bash', { command: 'pwd' })
  app.callbacks.onToolUse('b2', 'bash', { command: 'ls' })
  tr(app, 'b1', 'bash', '/home/user')
  tr(app, 'b2', 'bash', 'a.txt')
  app.callbacks.onAbort()

  const text = scrollbackPlain(app)
  assert.ok(text.includes('Ran 2 shell commands'), 'group should be flushed on abort')
})

// ── 非折叠 bash 不进入组 ───────────────────────────────────────

test('单个变更型 bash 直接渲染 tool card，不生成折叠组', () => {
  const { app } = makeApp()

  app.callbacks.onToolUse('b1', 'bash', { command: 'git commit -m "x"' })
  tr(app, 'b1', 'bash', '[main abc123] x')

  const text = scrollbackPlain(app)
  assert.ok(!text.includes('Ran 1 shell command'), 'should not create a collapsed bash group')
  assert.ok(text.includes('git commit'), 'should render command as tool card')
})
