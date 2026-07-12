/**
 * T9 流式渲染节流测试 — thinking / tool-result chunk 经 WriteBatcher 合并。
 *
 * Bug（修复前）：handleThinkingDelta / handleToolResult(streaming chunk) 每个
 * delta 直接 renderLive() → 全区域重绘 + stringWidth×N。DeepSeek reasoning_content
 * 是逐字高频流，深思期持续刷屏卡顿；正文流（blockWriter→writeBatcher）反而有节流。
 *
 * 契约（经 stdout 写入观测）：
 *  - 同一同步批次内 N 个 thinking delta → 当 tick 内 0 次写；microtask flush 后恰 1 次渲染。
 *  - tool-result streaming chunk 同口径合并。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { ReadStream, WriteStream } from 'node:tty'
import { TuiApp } from '../app.js'

class MockOut {
  columns = 120
  rows = 24
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
    cols: 120, rows: 24, modelName: 'test', contextWindow: 200_000,
  })
  app.start()
  return { app, out }
}

const microtask = () => Promise.resolve().then(() => {})

test('thinking delta 流经 WriteBatcher：同步批次合并为 1 次渲染', async () => {
  const { app, out } = makeApp()
  out.chunks = []

  // 同步连发 10 个 thinking delta（模拟 DeepSeek reasoning_content 逐字流）
  for (let i = 0; i < 10; i++) app.callbacks.onThinkingDelta(`tok${i} `)

  // 修复前：此处已有 10 次 renderLive 的写入；修复后：写入被推迟到 microtask
  assert.equal(out.chunks.length, 0, `同步阶段不应渲染（batched），实际写了 ${out.chunks.length} 次`)

  await microtask()
  const afterFlush = out.chunks.length
  assert.ok(afterFlush >= 1, 'microtask flush 后应渲染 1 次')

  // 再发一批，确认仍是「每 microtask 1 次」而非「每 token 1 次」
  out.chunks = []
  for (let i = 0; i < 10; i++) app.callbacks.onThinkingDelta(`x${i} `)
  assert.equal(out.chunks.length, 0, '第二批同步阶段同样不渲染')
  await microtask()
  assert.ok(out.chunks.length >= 1, '第二批 flush 后渲染')

  // 累积的 thinking 文本完整保留（节流不丢内容）
  assert.ok((app as unknown as { state: { thinkingText: string } }).state.thinkingText.includes('tok9'), 'thinking 文本累积完整')
})

test('tool-result streaming chunk 经 WriteBatcher 合并', async () => {
  const { app } = makeApp()
  let renders = 0
  const internals = app as unknown as { renderLive: () => void }
  internals.renderLive = () => { renders++ }

  // isError === undefined → streaming chunk 路径
  for (let i = 0; i < 8; i++) app.callbacks.onToolResult('t1', 'bash', `line${i}\n`, undefined)
  assert.equal(renders, 0, 'streaming chunk 同步阶段不渲染')

  await microtask()
  assert.equal(renders, 1, 'flush 后只渲染 1 次')
})

test('critical phase flush invalidates a queued streaming render', async () => {
  const { app } = makeApp()
  let renders = 0
  const internals = app as unknown as { renderLive: () => void }
  internals.renderLive = () => { renders++ }

  app.callbacks.onThinkingDelta('queued delta')
  assert.equal(renders, 0, 'delta remains scheduled')

  app.callbacks.onPhaseChange?.('waiting')
  assert.equal(renders, 1, 'phase change flushes immediately')

  await microtask()
  assert.equal(renders, 1, 'invalidated streaming microtask cannot double-render')
})

test('stable stream commit renders once while an unstable tail remains scheduled', async () => {
  const { app } = makeApp()
  let renders = 0
  const internals = app as unknown as { renderLive: () => void }
  internals.renderLive = () => { renders++ }

  app.callbacks.onTextDelta(`${'x'.repeat(31)}\n\n`)
  assert.equal(renders, 1, 'stable commit renders synchronously through commitAbove')
  await microtask()
  assert.equal(renders, 1, 'stable commit must not queue a duplicate render')

  app.callbacks.onTextDelta('unfinished live tail')
  assert.equal(renders, 1, 'tail render stays deferred')
  await microtask()
  assert.equal(renders, 2, 'tail without stable boundary still redraws')
})

test('app without a perf monitor emits no shutdown summary', () => {
  const out = new MockOut()
  const stdin = new MockIn()
  let summaries = 0
  const app = new TuiApp({
    stdout: out as unknown as WriteStream,
    stdin: stdin as unknown as ReadStream,
    cols: 120,
    rows: 24,
    onPerfSummary: () => { summaries++ },
  })

  app.dispose()
  assert.equal(summaries, 0)
})
