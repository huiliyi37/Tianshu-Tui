import { test } from 'node:test'
import assert from 'node:assert/strict'
import { eventReducer, initialEventState, type EventViewState } from '../event-reducer.ts'
import type { SessionEvent, SessionEventType } from '../../runtime/types.ts'

let seq = 0
function ev(type: SessionEventType, data: Record<string, unknown> = {}): SessionEvent {
  return { seq: ++seq, ts: Date.now(), type, data }
}
function fold(events: SessionEvent[]): EventViewState {
  return events.reduce((s, e) => eventReducer(s, { type: 'event', event: e }), initialEventState)
}

test('consecutive text_delta coalesce into one assistant block', () => {
  seq = 0
  const s = fold([ev('text_delta', { text: 'hel' }), ev('text_delta', { text: 'lo' })])
  assert.equal(s.blocks.length, 1)
  assert.equal(s.blocks[0]!.text, 'hello')
  assert.equal(s.blocks[0]!.kind, 'assistant')
})

test('tool_use breaks the text run; later text starts a new block', () => {
  seq = 0
  const s = fold([
    ev('text_delta', { text: 'a' }),
    ev('tool_use', { name: 'bash', input: { cmd: 'ls' } }),
    ev('text_delta', { text: 'b' }),
  ])
  assert.equal(s.blocks.length, 3)
  assert.equal(s.blocks[0]!.text, 'a')
  assert.equal(s.blocks[1]!.kind, 'tool')
  assert.equal(s.blocks[2]!.text, 'b')
})

test('approval_required sets pending, approval_resolved clears it', () => {
  seq = 0
  const after = fold([ev('approval_required', { requestId: 'r1', toolName: 'bash', input: {} })])
  assert.equal(after.pendingApproval?.requestId, 'r1')
  const resolved = eventReducer(after, { type: 'event', event: ev('approval_resolved', { requestId: 'r1' }) })
  assert.equal(resolved.pendingApproval, null)
})

test('intent_required/resolved tracked', () => {
  seq = 0
  const a = fold([ev('intent_required', { requestId: 'i1', summary: 's', confidence: 0.9 })])
  assert.equal(a.pendingIntent?.requestId, 'i1')
  assert.equal(a.pendingIntent?.confidence, 0.9)
  const b = eventReducer(a, { type: 'event', event: ev('intent_resolved', { requestId: 'i1' }) })
  assert.equal(b.pendingIntent, null)
})

test('artifact events bump artifactRev', () => {
  seq = 0
  const s = fold([ev('artifact', { id: 'a' }), ev('artifact', { id: 'b' })])
  assert.equal(s.artifactRev, 2)
})

test('delegation events upsert nodes by workerId', () => {
  seq = 0
  const s = fold([
    ev('delegation', { workerId: 'w1', objective: 'do x', status: 'running' }),
    ev('delegation', { workerId: 'w1', objective: 'do x', status: 'completed' }),
    ev('delegation', { workerId: 'w2', objective: 'do y', status: 'running' }),
  ])
  assert.equal(Object.keys(s.delegation).length, 2)
  assert.equal(s.delegation.w1!.status, 'completed')
})

test('replay is idempotent — events at or below lastSeq are ignored', () => {
  seq = 0
  const e1 = ev('text_delta', { text: 'x' })
  const s1 = eventReducer(initialEventState, { type: 'event', event: e1 })
  const s2 = eventReducer(s1, { type: 'event', event: e1 })
  assert.equal(s2.blocks.length, 1)
  assert.equal(s2.blocks[0]!.text, 'x')
  assert.equal(s2.lastSeq, e1.seq)
})

test('status and phase tracked', () => {
  seq = 0
  const s = fold([ev('status', { status: 'running' }), ev('phase', { phase: 'planning' })])
  assert.equal(s.status, 'running')
  assert.equal(s.phase, 'planning')
})

test('user event produces a user block (Q1)', () => {
  seq = 0
  const s = fold([ev('user', { text: '帮我修一下 bug' })])
  assert.equal(s.blocks.length, 1)
  assert.equal(s.blocks[0]!.kind, 'user')
  assert.equal(s.blocks[0]!.text, '帮我修一下 bug')
})

test('user event breaks an open text run (Q1)', () => {
  seq = 0
  const s = fold([
    ev('text_delta', { text: 'partial' }),
    ev('user', { text: 'next turn' }),
    ev('text_delta', { text: 'reply' }),
  ])
  assert.equal(s.blocks.length, 3)
  assert.equal(s.blocks[0]!.kind, 'assistant')
  assert.equal(s.blocks[1]!.kind, 'user')
  assert.equal(s.blocks[1]!.text, 'next turn')
  assert.equal(s.blocks[2]!.kind, 'assistant')
  assert.equal(s.blocks[2]!.text, 'reply')
})
