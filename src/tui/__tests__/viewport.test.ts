import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { viewportLines, latestHistoryItems } from '../viewport.js'

describe('viewportLines', () => {
  it('returns minLines when rows * ratio < minLines', () => {
    assert.equal(viewportLines(10, 0.6, 5), 6)  // floor(10*0.6)=6 > 5
    assert.equal(viewportLines(5, 0.6, 10), 10) // floor(5*0.6)=3 < 10 → 10
  })

  it('returns minLines when rows is 0', () => {
    assert.equal(viewportLines(0, 0.6, 8), 8)
  })

  it('clamps to maxLines when provided', () => {
    assert.equal(viewportLines(100, 0.6, 10, 40), 40) // floor(100*0.6)=60 > 40 → 40
  })

  it('returns floor(rows * ratio) in normal range', () => {
    assert.equal(viewportLines(50, 0.6, 5), 30)
    assert.equal(viewportLines(40, 0.4, 3), 16)
  })

  it('handles standard use cases', () => {
    // assistant-message: 60%, min 10
    assert.equal(viewportLines(40, 0.6, 10), 24)
    // thinking-message: 40%, min 3
    assert.equal(viewportLines(40, 0.4, 3), 16)
    // stream: 60%, min 8
    assert.equal(viewportLines(40, 0.6, 8), 24)
  })
})

describe('latestHistoryItems', () => {
  it('keeps all items when under the render cap', () => {
    assert.deepEqual(latestHistoryItems(['a', 'b'], 3), ['a', 'b'])
  })

  it('keeps only the latest items when over the render cap', () => {
    assert.deepEqual(latestHistoryItems(['a', 'b', 'c', 'd'], 2), ['c', 'd'])
  })

  it('returns empty for non-positive caps', () => {
    assert.deepEqual(latestHistoryItems(['a'], 0), [])
    assert.deepEqual(latestHistoryItems(['a'], -1), [])
  })
})
