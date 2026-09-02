import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { parseSessionPerformance, parseSessionPerformanceAsync } from '../session-performance.js'

// cache-log 轮级行（无 event 字段）+ 侧路行（event 字段，跳过）+ 坏行（跳过）。
const LOG = [
  JSON.stringify({ turn: 2, t: 200, model: 'm-b', input: 1000, cacheRead: 950, output: 200, ttftMs: 900, tps: 40.5 }),
  JSON.stringify({ event: 'side_path', kind: 'spec', input: 5 }),
  'not json at all',
  '',
  JSON.stringify({ turn: 1, t: 100, model: 'm-a', input: 800, cacheRead: 0, output: 100, ttftMs: 1200 }),
  JSON.stringify({ turn: 3, t: 300, model: 'm-b', input: 1200, cacheRead: 1100, output: 0 }),
].join('\n')

describe('parseSessionPerformance（同步）', () => {
  test('轮级行聚合：侧路/坏行跳过，按 turn 排序，hitRate/摘要口径正确', () => {
    const r = parseSessionPerformance(LOG)
    assert.equal(r.turns.length, 3)
    assert.deepEqual(r.turns.map(t => t.turn), [1, 2, 3])
    assert.equal(r.turns[1]!.hitRatePct, 95)
    assert.equal(r.turns[2]!.outputTokens, 0)
    assert.equal(r.summary.samples, 2) // turn 3 无 ttft
    assert.equal(r.summary.ttftAvgMs, 1050)
    assert.equal(r.summary.tpsAvg, 40.5)
  })

  test('空日志/全坏行 → turns 空 + samples 0', () => {
    for (const content of ['', 'garbage\n\ngarbage2']) {
      const r = parseSessionPerformance(content)
      assert.equal(r.turns.length, 0)
      assert.equal(r.summary.samples, 0)
      assert.equal(r.summary.ttftAvgMs, undefined)
    }
  })
})

describe('parseSessionPerformanceAsync（分片异步）', () => {
  test('与同步版逐字段一致（含坏行/侧路行/排序）', async () => {
    const sync = parseSessionPerformance(LOG)
    const async = await parseSessionPerformanceAsync(LOG, { chunkLines: 2 })
    assert.deepEqual(async, sync)
  })

  test('大日志分片路径：5000+ 行结果与同步版一致（chunkLines 强制多次让出）', async () => {
    const lines: string[] = []
    for (let i = 0; i < 5001; i++) {
      lines.push(JSON.stringify({ turn: i, t: i * 10, model: 'm', input: 100, cacheRead: 50, output: 10, ttftMs: 100 + (i % 7), tps: 20 + (i % 5) }))
      if (i % 97 === 0) lines.push('broken line')
    }
    const content = lines.join('\n')
    const sync = parseSessionPerformance(content)
    const async = await parseSessionPerformanceAsync(content, { chunkLines: 700 })
    assert.equal(async.turns.length, sync.turns.length)
    assert.deepEqual(async.summary, sync.summary)
    assert.equal(async.turns.length, 5001)
  })

  test('空内容 → 空结果', async () => {
    const r = await parseSessionPerformanceAsync('')
    assert.equal(r.turns.length, 0)
    assert.equal(r.summary.samples, 0)
  })
})
