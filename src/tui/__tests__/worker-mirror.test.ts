import { test } from 'node:test'
import assert from 'node:assert/strict'
import { WorkerMirrorStore, MIRROR_MESSAGE_CAP } from '../worker-mirror.js'
import type { DelegationActivity } from '../../tools/types.js'

function ev(over: Partial<DelegationActivity>): DelegationActivity {
  return { workOrderId: 'wo_1', parentToolId: 'd1', status: 'running', ...over }
}

test('WorkerMirror: text delta 聚合，tool_use 封口成独立消息', () => {
  const store = new WorkerMirrorStore()
  store.apply(ev({ eventKind: 'text', eventDetail: '我先看' }), 1)
  store.apply(ev({ eventKind: 'text', eventDetail: '一下代码' }), 2)
  store.apply(ev({ eventKind: 'tool_use', eventDetail: 'read_file' }), 3)
  store.apply(ev({ eventKind: 'tool_result', eventDetail: 'read_file' }), 4)

  const msgs = store.getMessages('wo_1')
  assert.equal(msgs.length, 3)
  assert.deepEqual(msgs[0], { kind: 'text', content: '我先看一下代码', at: 1 })
  assert.equal(msgs[1]!.kind, 'tool_use')
  assert.equal(msgs[1]!.content, 'read_file')
  assert.equal(msgs[2]!.kind, 'tool_result')
})

test('WorkerMirror: 进行中的 text 尾巴出现在 getMessages 末尾（未封口）', () => {
  const store = new WorkerMirrorStore()
  store.apply(ev({ eventKind: 'tool_use', eventDetail: 'grep' }), 1)
  store.apply(ev({ eventKind: 'text', eventDetail: '找到了' }), 2)
  const msgs = store.getMessages('wo_1')
  assert.equal(msgs.length, 2)
  assert.equal(msgs[1]!.kind, 'text')
  assert.equal(msgs[1]!.content, '找到了')
})

test('WorkerMirror: 终态封口 text 并追加 status 消息', () => {
  const store = new WorkerMirrorStore()
  store.apply(ev({ eventKind: 'text', eventDetail: '总结中' }), 1)
  store.apply(ev({ status: 'passed', progressLine: 'all done' }), 2)
  const msgs = store.getMessages('wo_1')
  assert.equal(msgs.length, 2)
  assert.equal(msgs[0]!.content, '总结中')
  assert.equal(msgs[1]!.kind, 'status')
  assert.ok(msgs[1]!.content.includes('passed'))
  assert.ok(msgs[1]!.content.includes('all done'))
})

test('WorkerMirror: thinking/turn 心跳不入镜像', () => {
  const store = new WorkerMirrorStore()
  store.apply(ev({ eventKind: 'thinking', eventDetail: '推理…' }), 1)
  store.apply(ev({ eventKind: 'turn', eventDetail: '1200' }), 2)
  assert.equal(store.getMessages('wo_1').length, 0)
})

test('WorkerMirror: cap 50 — 旧消息滚出', () => {
  const store = new WorkerMirrorStore()
  for (let i = 0; i < MIRROR_MESSAGE_CAP + 10; i++) {
    store.apply(ev({ eventKind: 'tool_use', eventDetail: `tool_${i}` }), i)
  }
  const msgs = store.getMessages('wo_1')
  assert.equal(msgs.length, MIRROR_MESSAGE_CAP)
  assert.equal(msgs[0]!.content, 'tool_10')
  assert.equal(msgs[msgs.length - 1]!.content, `tool_${MIRROR_MESSAGE_CAP + 9}`)
})

test('WorkerMirror: per-worker 隔离', () => {
  const store = new WorkerMirrorStore()
  store.apply(ev({ workOrderId: 'a', eventKind: 'tool_use', eventDetail: 'x' }), 1)
  store.apply(ev({ workOrderId: 'b', eventKind: 'tool_use', eventDetail: 'y' }), 1)
  assert.equal(store.getMessages('a').length, 1)
  assert.equal(store.getMessages('b').length, 1)
  assert.equal(store.getMessages('a')[0]!.content, 'x')
})
