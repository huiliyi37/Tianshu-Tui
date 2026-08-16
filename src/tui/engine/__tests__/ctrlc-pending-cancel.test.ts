/**
 * Ctrl+C pending-exit 确认窗口的取消契约。
 *
 * 背景：空闲 + 空输入第一次 Ctrl+C 进入「(Ctrl+C again to exit)」确认窗口
 * （2 秒），渲染层隐藏输入框只显示提示行。原实现该窗口只能等 2 秒超时或
 * 二次 Ctrl+C 退出，存在四个缺陷：
 *  1. Esc 无法取消——落到 idle 分支只记 lastEscAt，输入框不恢复；400ms 内
 *     双击 Esc 还会误开 rewind overlay；
 *  2. 幽灵输入——窗口内打字，文字进 value 但输入框仍被隐藏；
 *  3. 不可见提交——窗口内打的字（不可见）可被 Enter 提交；
 *  4. 带输入退出——窗口内打了字再 Ctrl+C 直接退出而非清空输入。
 *
 * 契约：Esc / 任意编辑键 / 粘贴 = 用户继续对话 → 取消确认、恢复输入框；
 * 有输入时二次 Ctrl+C 退化为「清空输入」，不退出。
 *
 * 跨平台：Ctrl+C(0x03) / Esc(0x1B lone) 在 Windows / macOS / Linux 终端的
 * raw mode 下字节送达一致（InputHandler 解析层无平台分支），契约对全平台等效。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { makeApp, stripAnsi } from './_harness.js'
import type { TuiApp } from '../app.js'

function makeStartedApp() {
  const t = makeApp()
  let exited = false
  t.app.onExit(() => { exited = true })
  const pendingSince = () =>
    (t.app as unknown as { inputController: { ctrlCPendingSince: number } }).inputController.ctrlCPendingSince
  const inputText = () =>
    (t.app as unknown as { inputLine: { value: string } }).inputLine.value
  const lastEscAt = () =>
    (t.app as unknown as { inputController: { lastEscAt: number } }).inputController.lastEscAt
  const plain = () => stripAnsi(t.out.chunks.join(''))
  return { ...t, exitedRef: () => exited, pendingSince, inputText, lastEscAt, plain }
}
type StartedApp = ReturnType<typeof makeStartedApp>
const CTRL_C = '\x03'
const ESC = '\x1B'
const HINT = '(Ctrl+C again to exit)'
const INPUT_BORDER = /[╭┏┌]/
const tick = (ms: number) => new Promise(r => setTimeout(r, ms))

test('Esc 取消退出确认：输入框恢复、提示消失、不污染 rewind 计时', async () => {
  const t = makeStartedApp()
  t.stdin.dataHandler!(CTRL_C)
  assert.ok(t.pendingSince() > 0, '第一次 Ctrl+C 进入确认窗口')
  assert.ok(t.plain().includes(HINT), '提示行显示')

  // MockOut 是累积写入流；「消失」断言只看取消动作之后的新增帧（行级 diff
  // 只重写变化行，旧帧文本会永远留在 chunks 里）。
  t.out.clear()
  t.stdin.dataHandler!(ESC)
  await tick(120) // lone ESC 经 80ms 超时派发
  assert.equal(t.pendingSince(), 0, 'Esc 取消确认窗口')
  assert.ok(!t.plain().includes(HINT), '提示行消失（新增帧不再写提示）')
  assert.ok(INPUT_BORDER.test(t.plain()), '输入框回归')
  assert.equal(t.lastEscAt(), 0, '取消用的 Esc 不计入双击 rewind 计时')
})

test('编辑键取消确认：打字立即可见，不再幽灵输入', async () => {
  const t = makeStartedApp()
  t.stdin.dataHandler!(CTRL_C)
  assert.ok(t.pendingSince() > 0, '进入确认窗口')
  t.out.clear()
  t.stdin.dataHandler!('a')
  await tick(60) // writeBatcher 异步合帧
  assert.equal(t.pendingSince(), 0, '编辑活动取消确认窗口')
  assert.equal(t.inputText(), 'a', '字符进输入框')
  assert.ok(t.plain().includes('a'), '打的字立即可见（输入框渲染）')
  assert.ok(!t.plain().includes(HINT), '提示行消失（新增帧不再写提示）')
})

test('确认窗口内打字后二次 Ctrl+C：清空输入而非退出', async () => {
  const t = makeStartedApp()
  t.stdin.dataHandler!(CTRL_C)
  t.stdin.dataHandler!('hi')
  await tick(60)
  t.stdin.dataHandler!(CTRL_C)
  await tick(30)
  assert.equal(t.exitedRef(), false, '有输入时不退出')
  assert.equal(t.inputText(), '', '退化为清空输入')
})

test('空输入时二次 Ctrl+C 仍然退出（原行为防回归）', async () => {
  const t = makeStartedApp()
  t.stdin.dataHandler!(CTRL_C)
  await tick(30)
  t.stdin.dataHandler!(CTRL_C)
  await tick(30)
  assert.equal(t.exitedRef(), true, '空输入确认窗口内二次 Ctrl+C 退出')
})

test('Esc 取消后可重新进入确认窗口（循环可用）', async () => {
  const t = makeStartedApp()
  t.stdin.dataHandler!(CTRL_C)
  t.stdin.dataHandler!(ESC)
  await tick(120)
  t.stdin.dataHandler!(CTRL_C)
  assert.ok(t.pendingSince() > 0, '取消后再次 Ctrl+C 重新进入确认窗口')
  assert.ok(t.plain().includes(HINT), '提示行再次显示')
})
