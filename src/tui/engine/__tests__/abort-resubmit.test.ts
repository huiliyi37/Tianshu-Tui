/**
 * T9 abort → resubmit 死会话回归测试（0A：统一 streaming 权威 + 世代守卫）。
 *
 * Bug：agent 卡在工具上时按 Esc/Ctrl+C 终止，之后怎么发消息都没反应。
 * 根因：main-ansi 模块级 isStreaming 与 TuiApp.agentBusy 双门，清除时机不同——
 * Esc 同步清 TuiApp 却从不清 main-ansi 的 isStreaming，下次 submit 被 `if(isStreaming)return` 吞，
 * 再后续输入又被 agentBusy 路由进 steerBuffer，会话彻底卡死。
 *
 * 契约：
 *  1. agentBusy 是唯一权威；abort 后再 submit 必须重新触发 onSubmit（不被吞、不入 steerBuffer）。
 *  2. wrapCallbacksWithTuiApp 捕获 run 世代；abort 后旧 run 的迟到回调被丢弃，
 *     不得清掉新 run 的 busy / 污染渲染（反向竞态）。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { ReadStream, WriteStream } from 'node:tty'
import { TuiApp } from '../app.js'
import { wrapCallbacksWithTuiApp } from '../bridge.js'
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

test('卡死的 run 被 Ctrl+C 中止后，再 submit 重新触发 onSubmit（不被吞、不入队）', async () => {
  const { app, stdin } = makeApp()
  const runs: string[] = []
  // 模拟 main-ansi：每次 onSubmit 即发起一次新 run（但本测试里 run 永不结束）
  app.onSubmit((t) => { runs.push(t) })

  // run A：submit → agentBusy=true，onSubmit('first') 触发，run 挂起不结束
  app.setInput('first')
  stdin.dataHandler!('\r')
  await tick()
  assert.deepEqual(runs, ['first'], 'run A 已发起')
  assert.equal(app.busy, true, '挂起的 run 使 agentBusy=true')

  // Ctrl+C 中止挂起的 run
  stdin.dataHandler!('\x03')
  await tick()
  assert.equal(app.busy, false, 'abort 后 agentBusy 同步复位')

  // run B：再次 submit → 必须重新触发 onSubmit，而非被吞或入 steerBuffer
  app.setInput('second')
  stdin.dataHandler!('\r')
  await tick()
  assert.deepEqual(runs, ['first', 'second'], 'abort 后 submit 必须重新发起 run')
  assert.equal(app.steerBuffer.hasPending(), false, '不得把新输入塞进 steerBuffer')
})

test('abort 后旧 run 的迟到 onAbort 被世代守卫丢弃，不清掉新 run 的 busy', async () => {
  const { app, stdin } = makeApp()
  app.onSubmit(() => { /* run 挂起 */ })

  // run A 开始 → 此刻 main-ansi 会 wrap 一组回调（捕获 A 的世代）
  app.setInput('A')
  stdin.dataHandler!('\r')
  await tick()
  const staleCallbacks = wrapCallbacksWithTuiApp(app)

  // 用户中止 run A（runGen 自增）
  stdin.dataHandler!('\x03')
  await tick()
  assert.equal(app.busy, false)

  // run B 开始（agentBusy 再次 true，世代为新值）
  app.setInput('B')
  stdin.dataHandler!('\r')
  await tick()
  assert.equal(app.busy, true, 'run B 正在执行')

  // run A 的循环此刻才真正 settle，迟到 onAbort 抵达 —— 必须被丢弃
  staleCallbacks.onAbort()
  assert.equal(app.busy, true, "旧 run A 的迟到 onAbort 不得清掉 run B 的 busy")
})

test('世代守卫：旧 run 的迟到 onApprovalRequired 自动拒绝', async () => {
  const { app, stdin } = makeApp()
  app.onSubmit(() => {})

  app.setInput('A')
  stdin.dataHandler!('\r')
  await tick()
  const staleCallbacks = wrapCallbacksWithTuiApp(app)

  stdin.dataHandler!('\x03') // abort run A → 世代自增
  await tick()

  const result = await staleCallbacks.onApprovalRequired('t1', 'bash', { command: 'rm -rf /' })
  assert.equal(result, false, '已死 run 的审批请求应自动拒绝，不弹 UI')
})
