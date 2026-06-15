/**
 * B1 回归：handleError 与 handleAbort 共用 resetRunLocalState()，
 * 统一清 pendingTools + toolAccumulator + fleet + liveTeamModel。
 *
 * 根因缺陷：handleError 原先只调 resetDelegationViz()（清 fleet + liveTeamModel），
 * 漏清 pendingTools 和 toolAccumulator → provider 在工具/委派回合报错后，
 * 下一轮 run 会读到上一轮的孤儿条目（live 区显示已死工具卡片、累加器跨 run 污染）。
 *
 * 验证策略：注入工具到 pendingTools（onToolUse），累加流式输出（onToolResult
 * with isError=undefined），触发 onError，然后渲染 live region，断言输出中
 * 不再包含工具卡片标题——证明 pendingTools 已被清空。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { ReadStream, WriteStream } from 'node:tty'
import { TuiApp } from '../app.js'
import { MockOut, MockIn } from './_harness.js'

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
const stripAnsi = (s: string) => s.replace(/\x1B\[[0-9;]*[a-zA-Z]/g, '')

test('handleError 清空 toolAccumulator——error 后终态提交不含残留流式数据', async () => {
  const { app, out } = makeApp()
  app.setStreamingState(true)

  // 注入工具 + 流式输出，然后 error
  app.callbacks.onToolUse('tool-1', 'bash', { command: 'ls' })
  app.callbacks.onToolResult('tool-1', 'bash', 'STALE_STREAM_DATA')
  await tick()
  app.callbacks.onError(new Error('crash'))
  await tick()

  // error 后发终态 onToolResult——如果 toolAccumulator 未被清理，
  // 终态会拼接 STALE_STREAM_DATA + final result 提交到 scrollback
  out.chunks.length = 0
  app.callbacks.onToolResult('tool-1', 'bash', 'FINAL_RESULT', false)
  await tick()

  const committed = stripAnsi(out.chunks.join(''))
  assert.ok(committed.includes('FINAL_RESULT'), '终态结果应提交到 scrollback')
  assert.ok(!committed.includes('STALE_STREAM_DATA'),
    'error 清理后终态提交不应拼接残留的流式数据（toolAccumulator 已清）')
})
test('handleError 与 handleAbort 收尾同口径——agentBusy 均复位', async () => {
  const { app } = makeApp()
  app.setStreamingState(true)
  app.callbacks.onToolUse('t1', 'bash', { command: 'echo hi' })
  await tick()

  // error 后 busy 应回 false
  app.callbacks.onError(new Error('test error'))
  await tick()
  assert.equal(app.busy, false, 'error 后 agentBusy 应回 false')

  // 再次注入并测 abort
  app.setStreamingState(true)
  app.callbacks.onToolUse('t2', 'bash', { command: 'echo bye' })
  await tick()

  app.callbacks.onAbort()
  await tick()
  assert.equal(app.busy, false, 'abort 后 agentBusy 应回 false')
})

test('handleError 后旧累加器不跨 run 泄露——终态提交不含上轮数据', async () => {
  const { app, out } = makeApp()
  app.setStreamingState(true)

  // 第一轮：注入工具 + 流式输出，然后 error
  app.callbacks.onToolUse('old-tool', 'bash', { command: 'cat huge-file' })
  app.callbacks.onToolResult('old-tool', 'bash', 'OLD_DATA_LEAK_MARKER_X9Y8')
  await tick()
  app.callbacks.onError(new Error('crash'))
  await tick()

  // 第二轮：相同 id 注入新工具，发终态 onToolResult
  // 如果 toolAccumulator 未在 error 时被清，终态会读到 OLD_DATA_LEAK_MARKER_X9Y8
  app.setStreamingState(true)
  app.callbacks.onToolUse('old-tool', 'bash', { command: 'echo new' })
  app.callbacks.onToolResult('old-tool', 'bash', 'NEW_FINAL_RESULT', false)
  await tick()

  const committed = stripAnsi(app.getScrollbackContent())
  // 终态结果应提交，旧数据不应泄露
  assert.ok(committed.includes('NEW_FINAL_RESULT'), '新终态结果应提交到 scrollback')
  assert.ok(!committed.includes('OLD_DATA_LEAK_MARKER_X9Y8'),
    'error 清理后旧累加器不应泄露到新 run 的终态提交')
})
