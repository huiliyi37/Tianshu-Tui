/**
 * 轮询连击折叠 e2e（app 级接线）— known-issue 2026-09-04 P1。
 *
 * 契约：
 * 1. 100 次 job(list)（use+result 交替）→ scrollback 只有 1 张聚合卡，计数正确；
 * 2. assistant 文本 / 异名工具（含另一个轮询工具）/ 用户消息 / 回合结束打断
 *    连击并 flush；打断后新连击开新卡；
 * 3. 中间轮边界（turn_complete isFinal=false）不打断——跨轮静默连击正是折叠目标；
 * 4. ×1 退化为普通工具卡（非连击场景零形态变化）；
 * 5. Ctrl+O 展开聚合卡能看到连击明细（最近 N 条 + 计数折叠）；
 * 6. read/search 折叠组等非折叠集行为零变化。
 *
 * 断言口径：scrollback 内容读 CommitEngine（getScrollbackContent），live 区
 * 写入不进 scrollback，无需关心渲染帧。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { makeApp, stripAnsi } from './_harness.js'
import type { TuiApp } from '../app.js'

const tick = () => new Promise(r => setTimeout(r, 10))

interface AppInternals {
  expandLastTruncatedTool: () => void
  commitUserPrompt: (content: string) => unknown
}

/** onToolResult 必须显式传 isError=false 才是 terminal result；undefined 会被当 streaming chunk */
function pollOnce(app: TuiApp, i: number, toolName = 'job', input: Record<string, unknown> = { action: 'list' }) {
  const id = `${toolName}-${i}`
  app.callbacks.onToolUse(id, toolName, input)
  app.callbacks.onToolResult(id, toolName, `result-${String(i).padStart(3, '0')}`, false)
}

function scrollbackPlain(app: TuiApp): string {
  return stripAnsi(app.getScrollbackContent())
}

function countOccurrences(text: string, needle: string): number {
  return text.split(needle).length - 1
}

// ── 验收：100× job(list) → 1 张聚合卡 ─────────────────────────

test('100 次 job(list) 连击 → scrollback 只产生 1 张聚合卡且计数正确', async () => {
  const { app } = makeApp()
  for (let i = 0; i < 100; i++) pollOnce(app, i)
  app.callbacks.onTurnComplete({ input_tokens: 100 }, 100, true)
  await tick()

  const text = scrollbackPlain(app)
  assert.equal(countOccurrences(text, '轮询 ×'), 1, `应只有 1 张聚合卡: ${text}`)
  assert.ok(text.includes('⏱ job 轮询 × 100（成功 100）'), text)
  // 逐次结果不单独落卡：只有最近一次调用的结果首行进卡片明细行
  assert.ok(text.includes('result-099'), '最近一次结果应在明细行可见')
  assert.ok(!text.includes('result-050'), '更早结果不应逐次落卡')
})

// ── 跨轮连击：中间轮边界不打断 ────────────────────────────────

test('中间轮 turn_complete(isFinal=false) 不打断连击（跨轮聚合成一卡）', async () => {
  const { app } = makeApp()
  for (let i = 0; i < 3; i++) pollOnce(app, i)
  app.callbacks.onTurnComplete({ input_tokens: 10 }, 1, false)
  for (let i = 3; i < 5; i++) pollOnce(app, i)
  app.callbacks.onTurnComplete({ input_tokens: 20 }, 2, true)
  await tick()

  const text = scrollbackPlain(app)
  assert.equal(countOccurrences(text, '轮询 ×'), 1, `跨轮连击应聚合成 1 卡: ${text}`)
  assert.ok(text.includes('轮询 × 5（成功 5）'), text)
})

// ── 打断：assistant 文本 ──────────────────────────────────────

test('assistant 文本打断连击：先 flush 聚合卡，打断后新连击开新卡', async () => {
  const { app } = makeApp()
  for (let i = 0; i < 5; i++) pollOnce(app, i)
  app.callbacks.onTextDelta('看看任务进度如何了')
  for (let i = 5; i < 10; i++) pollOnce(app, i)
  app.callbacks.onTurnComplete({ input_tokens: 10 }, 2, true)
  await tick()

  const text = scrollbackPlain(app)
  assert.equal(countOccurrences(text, '轮询 × 5（成功 5）'), 2, `文本前后两段连击应各落一卡: ${text}`)
  assert.ok(text.includes('看看任务进度如何了'), '文本应正常落版')
})

// ── 打断：异名工具（非折叠集 + 另一个轮询工具）─────────────────

test('异名非折叠工具打断连击', async () => {
  const { app } = makeApp()
  for (let i = 0; i < 3; i++) pollOnce(app, i)
  app.callbacks.onToolUse('w1', 'write_file', { file_path: 'out.ts' })
  app.callbacks.onToolResult('w1', 'write_file', 'ok', false)
  app.callbacks.onTurnComplete({ input_tokens: 10 }, 1, true)
  await tick()

  const text = scrollbackPlain(app)
  assert.ok(text.includes('⏱ job 轮询 × 3（成功 3）'), text)
  assert.ok(text.includes('out.ts'), 'write 工具卡照常渲染')
})

test('另一个轮询工具打断连击（job → monitor 各落各的聚合卡）', async () => {
  const { app } = makeApp()
  for (let i = 0; i < 3; i++) pollOnce(app, i, 'job')
  for (let i = 0; i < 2; i++) pollOnce(app, i, 'monitor')
  app.callbacks.onTurnComplete({ input_tokens: 10 }, 1, true)
  await tick()

  const text = scrollbackPlain(app)
  assert.ok(text.includes('⏱ job 轮询 × 3（成功 3）'), text)
  assert.ok(text.includes('⏱ monitor 轮询 × 2（成功 2）'), text)
  assert.equal(countOccurrences(text, '轮询 ×'), 2)
})

// ── 打断：用户消息 ────────────────────────────────────────────

test('用户消息打断连击（聚合卡先于气泡落版）', async () => {
  const { app } = makeApp()
  for (let i = 0; i < 4; i++) pollOnce(app, i)
  ;(app as unknown as AppInternals).commitUserPrompt('先别轮了')
  app.callbacks.onTurnComplete({ input_tokens: 10 }, 1, true)
  await tick()

  const text = scrollbackPlain(app)
  assert.ok(text.includes('⏱ job 轮询 × 4（成功 4）'), text)
  assert.ok(text.indexOf('轮询 × 4') < text.indexOf('先别轮了'), '聚合卡应在用户消息之前')
})

// ── 打断：abort / error ───────────────────────────────────────

test('abort 时 flush 残余连击组', async () => {
  const { app } = makeApp()
  for (let i = 0; i < 3; i++) pollOnce(app, i)
  app.callbacks.onAbort()
  await tick()

  const text = scrollbackPlain(app)
  assert.ok(text.includes('⏱ job 轮询 × 3（成功 3）'), text)
})

// ── ×1 退化：单次调用零形态变化 ────────────────────────────────

test('单次 job 调用不折叠：退化为普通工具卡（无「轮询 ×」字样）', async () => {
  const { app } = makeApp()
  app.callbacks.onToolUse('j1', 'job', { action: 'await', id: 'a1' })
  app.callbacks.onToolResult('j1', 'job', '[a1] exited (0) · 3s · npm run dev', false)
  app.callbacks.onTurnComplete({ input_tokens: 10 }, 1, true)
  await tick()

  const text = scrollbackPlain(app)
  assert.ok(!text.includes('轮询 ×'), `单次调用不应出现聚合卡: ${text}`)
  assert.ok(text.includes('[a1] exited (0)'), '结果内容按普通工具卡完整渲染')
})

// ── 在途 flush：全在途不落卡，迟到结果重开新组 ──────────────────

test('在途调用被文本打断时不落卡，结果到达后按 ×1 普通卡落版', async () => {
  const { app } = makeApp()
  app.callbacks.onToolUse('j1', 'job', { action: 'list' })
  // 结果未达时文本到达 → 打断；全在途组不落卡
  app.callbacks.onTextDelta('让我说明一下接下来的计划安排')
  app.callbacks.onToolResult('j1', 'job', 'late-result-body', false)
  app.callbacks.onTurnComplete({ input_tokens: 10 }, 1, true)
  await tick()

  const text = scrollbackPlain(app)
  assert.ok(!text.includes('轮询 ×'), `在途打断不应产生聚合卡: ${text}`)
  assert.ok(text.includes('late-result-body'), '迟到结果应按普通工具卡落版')
})

test('迟到的异名 result 不混入当前连击组', async () => {
  const { app } = makeApp()
  app.callbacks.onToolUse('j1', 'job', { action: 'await', id: 'a1' })
  // job 在途时 monitor 到达 → 打断（j1 在途组静默不落卡）
  app.callbacks.onToolUse('m1', 'monitor', { action: 'list' })
  // j1 迟到 result：当前活跃组是 monitor，异名 result 视为打断后自成新组
  app.callbacks.onToolResult('j1', 'job', 'job-late-content', false)
  app.callbacks.onToolResult('m1', 'monitor', 'monitor-content', false)
  app.callbacks.onTurnComplete({ input_tokens: 10 }, 1, true)
  await tick()

  const text = scrollbackPlain(app)
  assert.ok(text.includes('job-late-content'), text)
  assert.ok(text.includes('monitor-content'), text)
  assert.ok(!text.includes('轮询 ×'), `两段 ×1 都应退化为普通卡: ${text}`)
})

// ── Ctrl+O 展开 ───────────────────────────────────────────────

test('Ctrl+O 展开已落版聚合卡：列出连击明细（最近 N 条 + 计数折叠）', async () => {
  const { app } = makeApp()
  for (let i = 0; i < 15; i++) pollOnce(app, i)
  app.callbacks.onTurnComplete({ input_tokens: 10 }, 1, true)
  await tick()
  ;(app as unknown as AppInternals).expandLastTruncatedTool()
  await tick()

  const text = scrollbackPlain(app)
  assert.ok(text.includes('▼ ⏱ job 轮询 × 15（成功 15）'), text)
  assert.ok(text.includes('早前 5 次调用（已折叠）'), '超出上限的更早条目计数折叠')
  assert.ok(text.includes('#15 list ✓'), '最近一条明细应列出')
  assert.ok(text.includes('result-014'), '最近一条结果预览应可见')
  assert.ok(!text.includes('#5 list'), '超出上限的更早条目不列出')
})

test('Ctrl+O 展开 live 中的活跃连击：flush 并展开提交', async () => {
  const { app } = makeApp()
  for (let i = 0; i < 3; i++) pollOnce(app, i)
  ;(app as unknown as AppInternals).expandLastTruncatedTool()
  await tick()

  const text = scrollbackPlain(app)
  assert.ok(text.includes('▼ ⏱ job 轮询 × 3（成功 3）'), text)
  assert.ok(text.includes('#3 list ✓'), text)
})

// ── 非折叠集零变化：read/search 折叠组与轮询连击互打断 ──────────

test('read/search 折叠组行为不变；轮询工具打断 read 组', async () => {
  const { app } = makeApp()
  app.callbacks.onToolUse('r1', 'read_file', { file_path: 'a.ts' })
  app.callbacks.onToolResult('r1', 'read_file', 'content a', false)
  app.callbacks.onToolUse('r2', 'read_file', { file_path: 'b.ts' })
  app.callbacks.onToolResult('r2', 'read_file', 'content b', false)
  for (let i = 0; i < 2; i++) pollOnce(app, i)
  app.callbacks.onToolUse('r3', 'read_file', { file_path: 'c.ts' })
  app.callbacks.onToolResult('r3', 'read_file', 'content c', false)
  app.callbacks.onTurnComplete({ input_tokens: 10 }, 1, true)
  await tick()

  const text = scrollbackPlain(app)
  assert.ok(text.includes('Read 2 files'), `前段 read 组照常折叠: ${text}`)
  assert.ok(text.includes('⏱ job 轮询 × 2（成功 2）'), text)
  assert.ok(text.includes('Read 1 file'), '后段 read 自成新组')
})
