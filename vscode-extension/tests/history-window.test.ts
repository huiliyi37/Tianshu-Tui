import { test } from 'node:test'
import assert from 'node:assert/strict'
import { canLoadEarlier, mergeHistoryFloor } from '../webview-ui/src/history-window.ts'
import { classifyStreamEvent } from '../src/sidecar/stream-accept.ts'

test('canLoadEarlier: 磁盘起点早于窗口才可翻页', () => {
  assert.equal(canLoadEarlier(101, 1), true)
  assert.equal(canLoadEarlier(101, 101), false)
  assert.equal(canLoadEarlier(1, 1), false)
  assert.equal(canLoadEarlier(null, 1), false)
  assert.equal(canLoadEarlier(50, null), false)
})

test('mergeHistoryFloor: 重连只取更早的 floor，已加载历史不回缩', () => {
  assert.equal(mergeHistoryFloor(null, 80), 80)
  assert.equal(mergeHistoryFloor(40, 80), 40)
  assert.equal(mergeHistoryFloor(90, 80), 80)
})

test('classifyStreamEvent: seq=0 元事件放行且不占 lastSeq', () => {
  assert.equal(classifyStreamEvent(0, 0), 'meta')
  assert.equal(classifyStreamEvent(0, 40), 'meta')
  assert.equal(classifyStreamEvent(41, 40), 'next')
  assert.equal(classifyStreamEvent(40, 40), 'dup')
  assert.equal(classifyStreamEvent(3, 40), 'dup')
})
