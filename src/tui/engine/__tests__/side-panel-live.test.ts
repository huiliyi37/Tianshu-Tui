/**
 * Side panel 实时渲染集成测试。
 *
 * 契约：
 *  1. 终端宽度 ≥ 120 时，右侧固定渲染 side panel（todos / workers / 当前工具 / token）。
 *  2. 主内容区宽度相应压缩，底部 chrome 仍可见。
 *  3. 宽度 < 120 时回退到原居中布局，task/worker 列表仍出现在主区。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import stringWidth from 'string-width'
import { makeApp, stripAnsi } from './_harness.js'
import type { TodoItem } from '../../../tools/todo-store.js'

const mk = (id: string, content: string, status: TodoItem['status']): TodoItem => ({ id, content, status })

function lastFramePlain(out: { chunks: string[] }): string {
  return stripAnsi(out.chunks.join(''))
}

function lastFrameLines(out: { chunks: string[] }): string[] {
  return lastFramePlain(out).split('\n')
}

test('宽屏触发 side panel 并展示 todo 与当前工具', () => {
  const { app, out } = makeApp({ cols: 120, rows: 40 })
  app.setTodos([mk('1', 'side task', 'in_progress')])
  app.callbacks.onToolUse('t1', 'apply_edit', { replacement: 'foo' })

  const plain = lastFramePlain(out)
  assert.ok(plain.includes('tasks (1)'), `side panel tasks header: ${plain}`)
  assert.ok(plain.includes('▸ side task'), `todo item in side panel: ${plain}`)
  assert.ok(plain.includes('apply_edit'), `current tool in side panel: ${plain}`)

  const lines = lastFrameLines(out)
  const panelLine = lines.find(l => l.includes('tasks (1)'))
  assert.ok(panelLine, 'found merged side-panel line')
  assert.equal(stringWidth(panelLine), 120, 'merged line spans full terminal width')

  // 主区底部 chrome 仍保留
  assert.ok(plain.includes('天枢'), 'GlanceBar domain still visible')
  assert.ok(plain.includes('〉'), 'input prompt still visible')
})

test('宽屏下主区不再重复渲染 todo 列表', () => {
  const { app, out } = makeApp({ cols: 120, rows: 40 })
  app.setTodos([mk('1', 'only in side panel', 'in_progress')])

  const plain = lastFramePlain(out)
  // 主区原 task-list 使用 ◐ 图标；宽屏时应由 side panel 承载，主区不再出现
  assert.ok(!plain.includes('◐ only in side panel'), `no main-area todo duplicate: ${plain}`)
  assert.ok(plain.includes('▸ only in side panel'), 'todo appears in side panel')
})

test('窄屏（<120）不触发 side panel，主区布局不变', () => {
  const { app, out } = makeApp({ cols: 100, rows: 40 })
  app.setTodos([mk('1', 'main task', 'in_progress')])

  const plain = lastFramePlain(out)
  assert.ok(plain.includes('◐ main task'), `main-area todo rendered when narrow: ${plain}`)
  assert.ok(!plain.includes('tasks (1)'), `no side-panel header when narrow: ${plain}`)
})

test('side panel 展示 FleetRegistry 中的活跃 worker', () => {
  const { app, out } = makeApp({ cols: 120, rows: 40 })
  const activity = {
    workOrderId: 'wo_team:T1',
    parentToolId: 'tool_abc',
    profile: 'code_scout',
    authority: 'tianquan',
    status: 'running' as const,
    activity: '⚙ grep auth',
    timestamp: Date.now(),
  }
  ;(app as any).fleet.apply(activity)
  // fleet.apply 不直接触发渲染，通过 setTodos 触发一次 rerender
  app.setTodos([])

  const plain = lastFramePlain(out)
  assert.ok(plain.includes('worker'), `worker header in side panel: ${plain}`)
  assert.ok(plain.includes('T1'), `worker short label in side panel: ${plain}`)
})
