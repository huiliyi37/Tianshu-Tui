import { test } from 'node:test'
import assert from 'node:assert/strict'
import { resolveRewindPoint, type RewindPoint } from '../webview-ui/src/rewind-point.ts'

function point(over: Partial<RewindPoint> & { index: number }): RewindPoint {
  return { content: '', timestamp: 0, ...over }
}

test('#1 seq 精确命中优先于序数', () => {
  const points = [
    point({ seq: 10, index: 0, content: 'A' }),
    point({ seq: 20, index: 2, content: 'B' }),
    point({ seq: 30, index: 4, content: 'C' }),
  ]
  const items = [
    { kind: 'user', seq: 10 },
    { kind: 'assistant' },
    { kind: 'user', seq: 20 },
    { kind: 'assistant' },
    { kind: 'user', seq: 30 },
  ]
  const r = resolveRewindPoint(items, points, 20)
  assert.equal(r?.index, 2)
})

test('#2 seq 缺失但序数对齐 → 返回同序 point', () => {
  const points = [
    point({ index: 0, content: 'A' }),
    point({ seq: 20, index: 2, content: 'B' }),
    point({ index: 4, content: 'C' }),
  ]
  const items = [
    { kind: 'user', seq: 10 },
    { kind: 'assistant' },
    { kind: 'user', seq: 20 },
    { kind: 'assistant' },
    { kind: 'user', seq: 30 },
  ]
  const r = resolveRewindPoint(items, points, 30)
  assert.equal(r?.index, 4)
})

test('#3 seq 缺失且序数越界 → undefined', () => {
  const points = [point({ seq: 10, index: 0, content: 'A' })]
  const items = [
    { kind: 'user', seq: 10 },
    { kind: 'assistant' },
    { kind: 'user', seq: 20 },
  ]
  assert.equal(resolveRewindPoint(items, points, 20), undefined)
})

test('#4 assistant 块不参与序数计数', () => {
  const points = [
    point({ index: 0, content: 'A' }),
    point({ index: 3, content: 'B' }),
  ]
  const items = [
    { kind: 'user', seq: 10 },
    { kind: 'assistant' },
    { kind: 'assistant' },
    { kind: 'user', seq: 20 },
  ]
  const r = resolveRewindPoint(items, points, 20)
  assert.equal(r?.index, 3)
})

test('#5 空 points → undefined', () => {
  const items = [{ kind: 'user', seq: 10 }]
  assert.equal(resolveRewindPoint(items, [], 10), undefined)
})
