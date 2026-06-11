/**
 * T9 常驻任务面板测试（C）。
 *
 * 契约：
 *  1. setTodos 后面板出现在内容与 GlanceBar 之间；GlanceBar 与输入框仍可见
 *     （reservedTail 不被挤掉）。
 *  2. 收到 `todo` 工具结果后，经 todosProvider 拉取刷新面板。
 *  3. 空列表不渲染面板。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { ReadStream, WriteStream } from 'node:tty'
import { TuiApp } from '../app.js'
import type { TodoItem } from '../../../tools/todo-store.js'

class MockOut {
  columns = 100
  rows = 40
  chunks: string[] = []
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
    cols: 100, rows: 40, modelName: 'test',
  })
  return { app, out }
}

const stripAnsi = (s: string) => s.replace(/\x1B\[[0-9;]*[a-zA-Z]/g, '')
const mk = (id: string, content: string, status: TodoItem['status']): TodoItem => ({ id, content, status })

test('setTodos 渲染面板且 GlanceBar / 输入框仍可见', () => {
  const { app, out } = makeApp()
  app.setTodos([
    mk('1', 'first task', 'completed'),
    mk('2', 'second task', 'in_progress'),
    mk('3', 'third task', 'pending'),
  ])
  const plain = stripAnsi(out.chunks.join(''))
  assert.ok(plain.includes('◐ second task'), `panel shown: ${plain}`)
  assert.ok(plain.includes('天枢'), 'GlanceBar still visible (domain)')
  assert.ok(plain.includes('〉'), 'input line still visible')
})

test('todo 工具结果经 todosProvider 刷新面板', () => {
  const { app, out } = makeApp()
  let current: TodoItem[] = []
  app.setTodosProvider(() => current)
  // 模型写入 → provider 数据变化 → 工具结果触发刷新
  current = [mk('1', 'provider task', 'in_progress')]
  app.callbacks.onToolResult('t1', 'todo', 'Updated: 0/1 completed', false)
  const plain = stripAnsi(out.chunks.join(''))
  assert.ok(plain.includes('provider task'), `refreshed from provider: ${plain}`)
})

test('空列表不渲染面板（仅底部 chrome）', () => {
  const { app, out } = makeApp()
  app.setTodos([])
  const plain = stripAnsi(out.chunks.join(''))
  assert.ok(!plain.includes('◇ 任务'), 'no task panel header for empty list')
  assert.ok(plain.includes('天枢'), 'GlanceBar still visible')
})
