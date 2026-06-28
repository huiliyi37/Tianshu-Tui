/**
 * /tasks overlay 交互测试：选择、Enter 进入 worker detail pager、Tab 切换 filter。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { ReadStream, WriteStream } from 'node:tty'
import { TuiApp } from '../app.js'

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
  app.registerOverlays({
    tasksData: () => app.getTasksData(),
    pagerContent: () => ({ content: '(empty)', page: 0, title: 'Pager' }),
  })
  return { app, out }
}

function sendOverlayKey(app: TuiApp, key: { name: string; char: string }): void {
  ;(app as any).handleOverlayKey(key)
}

test('/tasks data includes running workers', () => {
  const { app } = makeApp()

  ;(app.callbacks as any).onToolUse('d1', 'delegate_batch', { objective: 'find bugs' })
  ;(app.callbacks as any).onDelegationActivity({ workOrderId: 'wo_1', parentToolId: 'd1', profile: 'reviewer', status: 'running', progressLine: '⚙ read_file' })
  ;(app.callbacks as any).onDelegationActivity({ workOrderId: 'wo_2', parentToolId: 'd1', profile: 'patcher', status: 'running', progressLine: '✎ edit_file' })

  const data = app.getTasksData('running')
  assert.equal(data.groups.length, 1)
  assert.equal(data.groups[0]!.workers.length, 2)
  assert.equal(data.filter, 'running')
})

test('/tasks selection moves with arrow keys and Enter opens pager', () => {
  const { app } = makeApp()

  ;(app.callbacks as any).onToolUse('d1', 'delegate_batch', { objective: 'find bugs' })
  ;(app.callbacks as any).onDelegationActivity({ workOrderId: 'wo_1', parentToolId: 'd1', profile: 'reviewer', status: 'running', progressLine: '⚙ read_file' })
  ;(app.callbacks as any).onDelegationActivity({ workOrderId: 'wo_2', parentToolId: 'd1', profile: 'patcher', status: 'running', progressLine: '✎ edit_file' })

  app.activateOverlay('tasks')
  assert.equal(app.activeOverlayId(), 'tasks')

  // move selection down to second worker
  sendOverlayKey(app, { name: 'down', char: '' })
  assert.equal(app['overlayController'].nav().tasksIndex, 1)

  // Enter opens pager (worker detail may not have session file, but overlay switches)
  sendOverlayKey(app, { name: 'return', char: '' })
  assert.equal(app.activeOverlayId(), 'pager')
  assert.equal(app.getWorkerDetailId(), 'wo_2')
})

test('/tasks Tab cycles filter', () => {
  const { app } = makeApp()

  ;(app.callbacks as any).onToolUse('d1', 'delegate_batch', { objective: 'find bugs' })
  ;(app.callbacks as any).onDelegationActivity({ workOrderId: 'wo_1', parentToolId: 'd1', profile: 'reviewer', status: 'running' })
  ;(app.callbacks as any).onDelegationActivity({ workOrderId: 'wo_2', parentToolId: 'd1', profile: 'patcher', status: 'passed' })
  ;(app.callbacks as any).onToolResult('d1', 'delegate_batch', JSON.stringify({ status: 'passed' }), false)

  app.activateOverlay('tasks')
  assert.equal(app['overlayController'].nav().tasksFilter, 'running')

  sendOverlayKey(app, { name: 'tab', char: '' })
  assert.equal(app['overlayController'].nav().tasksFilter, 'completed')

  sendOverlayKey(app, { name: 'tab', char: '' })
  assert.equal(app['overlayController'].nav().tasksFilter, 'all')

  sendOverlayKey(app, { name: 'tab', char: '' })
  assert.equal(app['overlayController'].nav().tasksFilter, 'running')
})

test('completed workers are retained after delegation result', () => {
  const { app } = makeApp()

  ;(app.callbacks as any).onToolUse('d1', 'delegate_batch', { objective: 'find bugs' })
  ;(app.callbacks as any).onDelegationActivity({ workOrderId: 'wo_1', parentToolId: 'd1', profile: 'reviewer', status: 'running' })
  ;(app.callbacks as any).onDelegationActivity({ workOrderId: 'wo_1', parentToolId: 'd1', status: 'passed', progressLine: 'done' })
  ;(app.callbacks as any).onToolResult('d1', 'delegate_batch', JSON.stringify({ status: 'passed' }), false)

  const data = app.getTasksData('completed')
  assert.equal(data.groups.length, 1)
  assert.equal(data.groups[0]!.workers.length, 1)
  assert.equal(data.groups[0]!.workers[0]!.workerId, 'wo_1')
})
