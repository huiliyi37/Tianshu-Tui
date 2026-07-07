/**
 * T9 输入批渲染测试（C2）。
 *
 * 契约：
 * - WriteBatcher 在同一 microtask 内多次 schedule 只 flush 一次。
 * - 连续输入多个字符经 change 分支批渲染：值正确，渲染合并。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { ReadStream, WriteStream } from 'node:tty'
import { WriteBatcher } from '../write-batcher.js'
import { TuiApp } from '../app.js'
import { MockOut, MockIn } from './_harness.js'

test('WriteBatcher 同 tick 多次 schedule 只 flush 一次', async () => {
  let flushes = 0
  const wb = new WriteBatcher(() => { flushes++ })
  wb.schedule()
  wb.schedule()
  wb.schedule()
  assert.equal(flushes, 0, '同步阶段尚未 flush')
  await Promise.resolve()
  assert.equal(flushes, 1, '合并为一次')
  wb.schedule()
  await Promise.resolve()
  assert.equal(flushes, 2, '下一 tick 再 flush 一次')
})

const tick = (ms = 10) => new Promise(r => setTimeout(r, ms))

test('连续输入多个字符经批渲染后值正确', async () => {
  const out = new MockOut()
  const stdin = new MockIn()
  const app = new TuiApp({
    stdout: out as unknown as WriteStream,
    stdin: stdin as unknown as ReadStream,
    cols: 80, rows: 24, modelName: 'test',
  })
  for (const ch of 'hello') stdin.dataHandler!(ch)
  await tick()
  assert.equal(app.getInputValue(), 'hello', '批渲染不丢字符')
})
