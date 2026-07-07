/**
 * T9 审批按键测试。
 *
 * Bug：审批模式下 Enter 既经 onAnyKey 落入 inputLine 触发 submit，
 * 又经 mode-bound approval:return 触发 approve —— 双触发，且会把输入框里的文本误提交。
 *
 * 契约：审批模式下按键只解析审批动作（y/return=approve、n/escape=deny、e=edit-approve），
 * 绝不落入 inputLine（不提交、不污染输入框）。
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

test('审批模式 Enter → 仅 approve 一次，不提交输入框（无双触发）', async () => {
  const { app, stdin } = makeApp()
  let submitCount = 0
  app.onSubmit(() => { submitCount++ })
  // 输入框里有残留文本，审批态 Enter 不应误提交它
  app.setInput('SHOULD_NOT_SUBMIT')

  let resolved: unknown = Symbol('unset')
  void app.callbacks.onApprovalRequired!('1', 'Bash', { command: 'ls' }).then(r => { resolved = r })

  stdin.dataHandler!('\r') // approval 模式下回车
  await tick()

  assert.deepEqual(resolved, { approved: true }, '应 approve 一次')
  assert.equal(submitCount, 0, '审批态 Enter 不应提交输入框文本')
})

test('审批模式 n → deny', async () => {
  const { app, stdin } = makeApp()
  let resolved: unknown = Symbol('unset')
  void app.callbacks.onApprovalRequired!('1', 'Bash', { command: 'ls' }).then(r => { resolved = r })
  stdin.dataHandler!('n')
  await tick()
  assert.equal(resolved, false, 'n 应 deny')
})

test('审批模式 y → approve', async () => {
  const { app, stdin } = makeApp()
  let resolved: unknown = Symbol('unset')
  void app.callbacks.onApprovalRequired!('1', 'Bash', { command: 'ls' }).then(r => { resolved = r })
  stdin.dataHandler!('y')
  await tick()
  assert.deepEqual(resolved, { approved: true }, 'y 应 approve')
})

test('审批模式 e → 不是 approve（假 edit 已移除，按键被吞）', async () => {
  const { app, stdin } = makeApp()
  let resolved: unknown = Symbol('unset')
  void app.callbacks.onApprovalRequired!('1', 'Bash', { command: 'ls' }).then(r => { resolved = r })
  stdin.dataHandler!('e')
  await tick()
  // 旧实现 e===approve 是误导性假动作；现在 e 被吞，审批仍 pending（resolved 保持哨兵 symbol）
  assert.ok(typeof resolved === 'symbol', 'e 不应 resolve 审批（仍 pending）')
})
