/**
 * 活动期定高视口测试（TUI 输入框钉底）。
 *
 * 契约：
 *  1. padDynamicRegion 把动态段垫高/截断到恰好 budget display rows：
 *     - 不足 → 在动态内容与 chrome 之间垫空行（内容贴上、输入框贴下）；
 *     - 超出 → 从顶部截最旧行（approval 等关键内容在动态段尾部，天然保留）；
 *     - budget<=0 → 原样返回（空闲塌回）。
 *  2. TuiApp 活动期（thinking/streaming）连续帧的 live region 总 display rows
 *     恒定 —— 输入框屏幕坐标不随字符增长浮动。
 *  3. turn 结束（phase → idle）后塌回 chrome-only（高度小于活动期）。
 *  4. 小终端（rows=10）预算收缩，live region 不超屏。
 *  5. liveMaxRowsFor 终端高度感知（min(28, rows-1)，下限 4）。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { padDynamicRegion, type LiveRegionLine } from '../live-engine.js'
import { liveMaxRowsFor } from '../app.js'
import { makeApp } from './_harness.js'

const L = (...texts: string[]): LiveRegionLine[] => texts.map(text => ({ text }))

// ── padDynamicRegion 纯函数 ─────────────────────────────────────

test('不足预算：动态内容与 chrome 之间垫空行到恰好 budget，chromeStart 相应后移', () => {
  const lines = [...L('spinner', 'thinking'), ...L('input-top', 'input', 'input-bot')]
  const r = padDynamicRegion(lines, 2, 6)
  assert.equal(r.chromeStart, 6, 'chromeStart = 2 dynamic + 4 padding')
  assert.equal(r.lines.length, 9, '6 dynamic rows + 3 chrome')
  assert.deepEqual(r.lines.slice(0, 2).map(l => l.text), ['spinner', 'thinking'], '动态内容贴上')
  assert.ok(r.lines.slice(2, 6).every(l => l.text === ''), '空行垫在内容与 chrome 之间')
  assert.deepEqual(r.lines.slice(6).map(l => l.text), ['input-top', 'input', 'input-bot'], 'chrome 不动')
})

test('超出预算：从顶部截最旧行，动态段尾部（approval）保留', () => {
  const dynamic = L('old-1', 'old-2', 'old-3', 'old-4', 'approval-prompt')
  const chrome = L('input')
  const r = padDynamicRegion([...dynamic, ...chrome], 5, 3)
  assert.equal(r.chromeStart, 3)
  assert.deepEqual(r.lines.map(l => l.text), ['old-3', 'old-4', 'approval-prompt', 'input'])
})

test('恰好等于预算：原样保留，无垫行无截断', () => {
  const lines = [...L('a', 'b', 'c'), ...L('input')]
  const r = padDynamicRegion(lines, 3, 3)
  assert.deepEqual(r.lines.map(l => l.text), ['a', 'b', 'c', 'input'])
  assert.equal(r.chromeStart, 3)
})

test('budget<=0：原样返回（空闲塌回自然流）', () => {
  const lines = [...L('a'), ...L('input')]
  const r = padDynamicRegion(lines, 1, 0)
  assert.deepEqual(r.lines.map(l => l.text), ['a', 'input'])
  assert.equal(r.chromeStart, 1)
})

test('动态段为空：全部垫空行到 budget', () => {
  const r = padDynamicRegion(L('input'), 0, 4)
  assert.equal(r.chromeStart, 4)
  assert.ok(r.lines.slice(0, 4).every(l => l.text === ''))
  assert.equal(r.lines[4]!.text, 'input')
})

test('多 display-row 行按 measure 计数；整行丢弃低于预算后垫空行补齐到恰好 budget', () => {
  // wide 行占 3 display rows。budget=4：丢弃 wide(3) 后剩 a+b=2 rows < 4 → 垫 2 空行。
  const measure = (text: string): number => (text === 'wide' ? 3 : 1)
  const lines = [...L('wide', 'a', 'b'), ...L('input')]
  const r = padDynamicRegion(lines, 3, 4, measure)
  assert.deepEqual(r.lines.map(l => l.text), ['a', 'b', '', '', 'input'])
  assert.equal(r.chromeStart, 4)
  const total = r.lines.slice(0, r.chromeStart).reduce((s, l) => s + measure(l.text), 0)
  assert.equal(total, 4, '动态段恒等于 budget display rows')
})

// ── liveMaxRowsFor ──────────────────────────────────────────────

test('liveMaxRowsFor：高终端封顶 28，小终端 rows-1，下限 4，非法值回退', () => {
  assert.equal(liveMaxRowsFor(50), 28)
  assert.equal(liveMaxRowsFor(29), 28)
  assert.equal(liveMaxRowsFor(20), 19)
  assert.equal(liveMaxRowsFor(10), 9)
  assert.equal(liveMaxRowsFor(4), 4)
  assert.equal(liveMaxRowsFor(2), 4, '下限 4：宁可超行不裁输入框')
  assert.equal(liveMaxRowsFor(0), 23, 'rows 缺失回退 24-1')
})

// ── TuiApp 集成：帧高度稳定性 ───────────────────────────────────

const flush = (): Promise<void> => new Promise((resolve) => setImmediate(resolve))
const liveRows = (app: unknown): number => (app as { live: { lastDisplayRows: number } }).live.lastDisplayRows

test('thinking 逐字增长期间 live region 总高度逐帧恒定（输入框不浮动）', async () => {
  const { app } = makeApp({ cols: 80, rows: 40 })
  const heights: number[] = []
  for (let i = 0; i < 12; i++) {
    app.callbacks.onThinkingDelta(`推理片段 ${i}：分析代码结构与依赖关系。\n`)
    await flush()
    heights.push(liveRows(app))
  }
  const first = heights[0]!
  assert.ok(first > 5, `活动期视口应有可观高度: ${first}`)
  for (const [i, h] of heights.entries()) {
    assert.equal(h, first, `第 ${i} 帧高度漂移: ${h} != ${first}（heights=${heights.join(',')}）`)
  }
})

test('streaming 文本增长期间高度同样恒定', async () => {
  const { app } = makeApp({ cols: 80, rows: 40 })
  const heights: number[] = []
  for (let i = 0; i < 10; i++) {
    app.callbacks.onTextDelta(`streaming output chunk ${i} with some longer content to fill the tail. `)
    await flush()
    heights.push(liveRows(app))
  }
  const first = heights[0]!
  assert.ok(first > 5)
  for (const h of heights) assert.equal(h, first)
})

test('turn 结束（isFinal）后塌回 chrome-only，高度小于活动期', async () => {
  const { app } = makeApp({ cols: 80, rows: 40 })
  app.callbacks.onThinkingDelta('思考中……\n')
  await flush()
  const active = liveRows(app)
  assert.ok(active > 5)

  await (app as unknown as { handleTurnComplete: (u: object, t: number, f: boolean) => Promise<void> })
    .handleTurnComplete({ input_tokens: 10, output_tokens: 5 }, 1, true)
  await flush()
  const idle = liveRows(app)
  assert.ok(idle < active, `空闲期应塌回: idle=${idle} active=${active}`)
})

test('小终端（rows=10）预算收缩，live region 不超屏', async () => {
  const { app } = makeApp({ cols: 80, rows: 10 })
  for (let i = 0; i < 8; i++) {
    app.callbacks.onThinkingDelta(`小屏思考片段 ${i}\n`)
    await flush()
    assert.ok(liveRows(app) <= 10, `live region 超屏: ${liveRows(app)} > 10`)
  }
})
