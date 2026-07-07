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
  return { app, out, stdin }
}

const tick = (ms = 10) => new Promise(r => setTimeout(r, ms))

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

test('/tasks 单 worker 时直进 detail pager（列表页无信息增量）', () => {
  const { app } = makeApp()

  ;(app.callbacks as any).onToolUse('d1', 'delegate_task', { objective: 'fix bug' })
  ;(app.callbacks as any).onDelegationActivity({ workOrderId: 'wo_only', parentToolId: 'd1', profile: 'patcher', status: 'running', progressLine: '⚙ edit' })

  app.activateOverlay('tasks')
  assert.equal(app.activeOverlayId(), 'pager')
  assert.equal(app.getWorkerDetailId(), 'wo_only')
})

test('/tasks x 键调用 workerKill 回调（选中 worker）', () => {
  const { app } = makeApp()
  const killed: string[] = []
  app.setWorkerKill(id => { killed.push(id); return true })

  ;(app.callbacks as any).onToolUse('d1', 'delegate_batch', { objective: 'x' })
  ;(app.callbacks as any).onDelegationActivity({ workOrderId: 'wo_1', parentToolId: 'd1', profile: 'reviewer', status: 'running' })
  ;(app.callbacks as any).onDelegationActivity({ workOrderId: 'wo_2', parentToolId: 'd1', profile: 'patcher', status: 'running' })

  app.activateOverlay('tasks')
  sendOverlayKey(app, { name: 'down', char: '' })
  sendOverlayKey(app, { name: 'x', char: 'x' })
  assert.deepEqual(killed, ['wo_2'])
})

test('unread：终态未查看标记，openWorkerDetail 后清除', () => {
  const { app } = makeApp()

  ;(app.callbacks as any).onToolUse('d1', 'delegate_batch', { objective: 'x' })
  ;(app.callbacks as any).onDelegationActivity({ workOrderId: 'wo_1', parentToolId: 'd1', profile: 'reviewer', status: 'running' })
  ;(app.callbacks as any).onDelegationActivity({ workOrderId: 'wo_2', parentToolId: 'd1', profile: 'patcher', status: 'running' })
  ;(app.callbacks as any).onDelegationActivity({ workOrderId: 'wo_1', parentToolId: 'd1', status: 'passed', progressLine: 'done' })

  const before = app.getTasksData('all')
  const w1 = before.groups[0]!.workers.find(w => w.workerId === 'wo_1')!
  const w2 = before.groups[0]!.workers.find(w => w.workerId === 'wo_2')!
  assert.equal(w1.unread, true, '终态未查看 → unread')
  assert.equal(w2.unread, false, '运行中不标 unread')

  app.openWorkerDetail('wo_1')
  const after = app.getTasksData('all')
  assert.equal(after.groups[0]!.workers.find(w => w.workerId === 'wo_1')!.unread, false)
})

test('worker 终态转变 → 主区完成通知行（含计数与耗时）', () => {
  const { app, out } = makeApp()

  ;(app.callbacks as any).onDelegationActivity({ workOrderId: 'wo_n', parentToolId: 'd1', profile: 'reviewer', status: 'running', progressLine: '⚙ read_file', toolUseCount: 3, tokenCount: 1500 })
  ;(app.callbacks as any).onDelegationActivity({ workOrderId: 'wo_n', parentToolId: 'd1', status: 'passed', progressLine: 'all good' })

  const output = out.chunks.join('')
  assert.ok(output.includes('子代理完成'), `应有完成通知: ${output.slice(-300)}`)
  assert.ok(output.includes('3 工具'), '通知含工具计数')
  assert.ok(output.includes('all good'), '通知含终态摘要')
})

test('纯终态回放（未见 running）不触发通知', () => {
  const { app, out } = makeApp()

  ;(app.callbacks as any).onDelegationActivity({ workOrderId: 'wo_r', parentToolId: 'd1', status: 'passed', progressLine: 'replay' })

  const output = out.chunks.join('')
  assert.ok(!output.includes('子代理完成'), '不应通知')
})

test('/tasks f 键切入 worker 视图，Esc 退出', async () => {
  const { app, stdin } = makeApp()

  ;(app.callbacks as any).onToolUse('d1', 'delegate_batch', { objective: 'x' })
  ;(app.callbacks as any).onDelegationActivity({ workOrderId: 'wo_1', parentToolId: 'd1', profile: 'reviewer', status: 'running' })
  ;(app.callbacks as any).onDelegationActivity({ workOrderId: 'wo_2', parentToolId: 'd1', profile: 'patcher', status: 'running' })

  app.activateOverlay('tasks')
  sendOverlayKey(app, { name: 'down', char: '' })
  sendOverlayKey(app, { name: 'f', char: 'f' })
  assert.equal(app.activeOverlayId(), null, 'f 关闭 overlay')
  assert.equal(app.getViewingWorkerId(), 'wo_2', '切入选中 worker 视图')

  // Esc 退出视图回主视图（lone ESC 经 escape 超时派发）
  stdin.dataHandler!('\x1b')
  await tick(150)
  assert.equal(app.getViewingWorkerId(), null)
})

test('worker 视图内输入直达 steer 回调，不进主 agent', async () => {
  const { app, out, stdin } = makeApp()
  const steered: Array<{ id: string; text: string }> = []
  app.setWorkerSteer((id, text) => { steered.push({ id, text }); return true })
  const mainSubmits: string[] = []
  app.onSubmit(text => { mainSubmits.push(text) })

  ;(app.callbacks as any).onToolUse('d1', 'delegate_batch', { objective: 'x' })
  ;(app.callbacks as any).onDelegationActivity({ workOrderId: 'wo_s', parentToolId: 'd1', profile: 'reviewer', status: 'running' })
  ;(app.callbacks as any).onDelegationActivity({ workOrderId: 'wo_t', parentToolId: 'd1', profile: 'patcher', status: 'running' })

  app.enterWorkerView('wo_s')
  app.setInput('先检查测试目录')
  stdin.dataHandler!('\r')
  await tick()

  assert.deepEqual(steered, [{ id: 'wo_s', text: '先检查测试目录' }])
  assert.deepEqual(mainSubmits, [], '不应流入主 agent')
  const output = out.chunks.join('')
  assert.ok(output.includes('→'), '视图内提交回显路由目标')
})

test('worker 视图内 steer 未送达时提示警告', async () => {
  const { app, out, stdin } = makeApp()
  app.setWorkerSteer(() => false)

  ;(app.callbacks as any).onDelegationActivity({ workOrderId: 'wo_dead', parentToolId: 'd1', profile: 'reviewer', status: 'running' })
  ;(app.callbacks as any).onDelegationActivity({ workOrderId: 'wo_dead', parentToolId: 'd1', status: 'passed', progressLine: 'done' })

  app.enterWorkerView('wo_dead')
  app.setInput('太迟了')
  stdin.dataHandler!('\r')
  await tick()

  const output = out.chunks.join('')
  assert.ok(output.includes('未送达'), '应提示消息未送达')
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
