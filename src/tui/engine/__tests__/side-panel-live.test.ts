/**
 * Side panel 实时渲染集成测试。
 *
 * 契约：
 *  1. 终端宽度 ≥ 120 且用户显式展开后，右侧渲染 side panel（todos / workers / 当前工具 / token / 计划 / 快捷键提示）。
 *  2. 主内容区宽度相应压缩，底部 chrome 仍可见。
 *  3. 宽度 < 120 时回退到原居中布局，task/worker 列表仍出现在主区。
 *  4. 默认状态下右侧面板折叠。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { displayWidth } from '../../width.js'
import { makeApp, stripAnsi } from './_harness.js'
import type { TodoItem } from '../../../tools/todo-store.js'

const mk = (id: string, content: string, status: TodoItem['status']): TodoItem => ({ id, content, status })

function lastFramePlain(out: { chunks: string[] }): string {
  return stripAnsi(out.chunks.join(''))
}

function lastFrameLines(out: { chunks: string[] }): string[] {
  return lastFramePlain(out).split('\n')
}

test('宽屏显式展开后 side panel 展示 todo 与当前工具', () => {
  const { app, out } = makeApp({ cols: 120, rows: 40 })
  app.setSidePanelOpen(true)
  app.setTodos([mk('1', 'side task', 'in_progress')])
  out.chunks = []
  app.callbacks.onToolUse('t1', 'apply_edit', { replacement: 'foo' })

  const plain = lastFramePlain(out)
  assert.ok(plain.includes('◇ 任务'), `side panel tasks header: ${plain}`)
  assert.ok(plain.includes('▸ ◐ side task'), `todo item in side panel: ${plain}`)
  assert.ok(plain.includes('apply_edit'), `current tool in side panel: ${plain}`)

  const lines = lastFrameLines(out)
  const panelLine = lines.find(l => l.includes('◇ 任务'))
  assert.ok(panelLine, 'found merged side-panel line')
  assert.equal(displayWidth(panelLine, { ambiguousAsWide: true }), 120, 'merged line spans full terminal width')

  // 主区底部 chrome 仍保留
  assert.ok(plain.includes('天枢'), 'GlanceBar domain still visible')
  assert.ok(plain.includes('❯'), 'input prompt still visible')
})

test('宽屏展开面板后主区不再重复渲染 todo 列表', () => {
  const { app, out } = makeApp({ cols: 120, rows: 40 })
  app.setSidePanelOpen(true)
  out.chunks = []
  app.setTodos([mk('1', 'only in side panel', 'in_progress')])

  const plain = lastFramePlain(out)
  // 任务应出现在右侧面板内，主区不再出现独立 task-list 块
  assert.ok(plain.includes('▸ ◐ only in side panel'), 'todo appears in side panel')
  // 主区行不应出现 task-list 标题（panel 标题带边框，主区没有）
  const lines = lastFrameLines(out)
  const mainAreaTaskHeader = lines.find(l => l.includes('◇ 任务') && !l.includes('│'))
  assert.ok(!mainAreaTaskHeader, `no main-area todo duplicate: ${plain}`)
})

test('默认折叠状态下宽屏不触发 side panel，主区保留 task 列表', () => {
  const { app, out } = makeApp({ cols: 120, rows: 40 })
  app.setTodos([mk('1', 'default fold task', 'in_progress')])

  const plain = lastFramePlain(out)
  // 快捷键提示仅出现在 side panel 中
  assert.ok(!plain.includes('] toggle · ctrl+x r open'), `no side-panel chrome when folded: ${plain}`)
  assert.ok(plain.includes('▸ ◐ default fold task'), 'todo rendered in main area when panel folded')
})

test('窄屏（<120）不触发 side panel，主区布局不变', () => {
  const { app, out } = makeApp({ cols: 100, rows: 40 })
  app.setTodos([mk('1', 'main task', 'in_progress')])

  const plain = lastFramePlain(out)
  assert.ok(plain.includes('▸ ◐ main task'), `main-area todo rendered when narrow: ${plain}`)
  assert.ok(!plain.includes('] toggle · ctrl+x r open'), `no side-panel chrome when narrow: ${plain}`)
})

test('side panel 展示 FleetRegistry 中的活跃 worker', () => {
  const { app, out } = makeApp({ cols: 120, rows: 40 })
  app.setSidePanelOpen(true)
  out.chunks = []
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
  // 统一渲染后侧栏与主区共用 formatWorkerRow：显示星名·职能名而非 shortLabel。
  assert.ok(plain.includes('侦察'), `worker profile label in side panel (unified): ${plain}`)
})
