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

test('decision_shift produces a card block with structured payload (R5)', () => {
  seq = 0
  const s = fold([ev('decision_shift', {
    source: 'kick',
    domain: '天璇',
    reason: '检测到停滞',
    methods: ['换用 grep', '重新框定问题'],
    severity: 'warn',
  })])
  assert.equal(s.blocks.length, 1)
  const b = s.blocks[0]!
  assert.equal(b.kind, 'decision_shift')
  assert.equal(b.shift?.domain, '天璇')
  assert.equal(b.shift?.reason, '检测到停滞')
  assert.deepEqual(b.shift?.methods, ['换用 grep', '重新框定问题'])
  assert.equal(b.shift?.severity, 'warn')
})

test('decision_shift breaks an open text run (R5)', () => {
  seq = 0
  const s = fold([
    ev('text_delta', { text: 'thinking' }),
    ev('decision_shift', { source: 'convergence', reason: 'stuck', methods: ['x'] }),
    ev('text_delta', { text: 'new approach' }),
  ])
  assert.equal(s.blocks.length, 3)
  assert.equal(s.blocks[0]!.kind, 'assistant')
  assert.equal(s.blocks[1]!.kind, 'decision_shift')
  assert.equal(s.blocks[2]!.kind, 'assistant')
  assert.equal(s.blocks[2]!.text, 'new approach')
})

// ── T1: process event rendering ─────────────────────────────────────

test('T1: consecutive thinking_delta coalesce into one reasoning block', () => {
  seq = 0
  const s = fold([ev('thinking_delta', { text: 'rea' }), ev('thinking_delta', { text: 'son' })])
  assert.equal(s.blocks.length, 1)
  assert.equal(s.blocks[0]!.kind, 'thinking')
  assert.equal(s.blocks[0]!.text, 'reason')
})

test('T1: thinking and text are separate runs that interrupt each other', () => {
  seq = 0
  const s = fold([
    ev('thinking_delta', { text: 'plan' }),
    ev('text_delta', { text: 'answer' }),
    ev('thinking_delta', { text: 'more' }),
  ])
  assert.equal(s.blocks.length, 3)
  assert.equal(s.blocks[0]!.kind, 'thinking')
  assert.equal(s.blocks[1]!.kind, 'assistant')
  assert.equal(s.blocks[2]!.kind, 'thinking')
})

test('T1: turn_complete adds a turn block with usage metadata', () => {
  seq = 0
  const s = fold([ev('turn_complete', { turnNumber: 2, isFinal: false, usage: { totalTokens: 1500 } })])
  assert.equal(s.blocks.length, 1)
  assert.equal(s.blocks[0]!.kind, 'turn')
  assert.equal(s.blocks[0]!.turn?.turnNumber, 2)
  assert.equal(s.blocks[0]!.turn?.totalTokens, 1500)
  assert.equal(s.blocks[0]!.turn?.isFinal, false)
})

test('T1: checkpoint adds an anchor block; empty hash is ignored', () => {
  seq = 0
  const s = fold([ev('checkpoint', { hash: 'abc123' }), ev('checkpoint', { hash: '' })])
  assert.equal(s.blocks.length, 1)
  assert.equal(s.blocks[0]!.kind, 'checkpoint')
  assert.equal(s.blocks[0]!.hash, 'abc123')
})

// ── T2: todo_state ──────────────────────────────────────────────────

test('T2: todo_state replaces the active task list', () => {
  seq = 0
  const s = fold([
    ev('todo_state', { items: [{ id: 'a', content: 'x', status: 'pending' }] }),
    ev('todo_state', { items: [
      { id: 'a', content: 'x', status: 'completed' },
      { id: 'b', content: 'y', status: 'in_progress' },
    ] }),
  ])
  assert.equal(s.todos.length, 2)
  assert.equal(s.todos[0]!.status, 'completed')
  assert.equal(s.todos[1]!.status, 'in_progress')
})

test('T2: todo_state drops malformed items', () => {
  seq = 0
  const s = fold([ev('todo_state', { items: [
    { id: 'a', content: 'ok', status: 'pending' },
    { id: '', content: 'no id', status: 'pending' },
    { content: 'no id key', status: 'pending' },
    'garbage',
  ] })])
  assert.equal(s.todos.length, 1)
  assert.equal(s.todos[0]!.id, 'a')
})

// ── T3: steer_queued ────────────────────────────────────────────────

test('T3: steer_queued produces a steer block', () => {
  seq = 0
  const s = fold([ev('steer_queued', { text: 'focus on tests' })])
  assert.equal(s.blocks.length, 1)
  assert.equal(s.blocks[0]!.kind, 'steer')
  assert.equal(s.blocks[0]!.text, 'focus on tests')
})

// ── T4: structured delegation merge ─────────────────────────────────

test('T4: delegation merges fields; terminal update keeps prior objective', () => {
  seq = 0
  const s = fold([
    ev('delegation', { workerId: 'wo:T1', parentId: 'tool-1', objective: 'scan', profile: 'code_scout', status: 'running', progressLine: '⚙ grep', elapsedMs: 1200 }),
    ev('delegation', { workerId: 'wo:T1', parentId: 'tool-1', status: 'passed', progressLine: 'done', elapsedMs: 3400 }),
  ])
  const node = s.delegation['wo:T1']!
  assert.equal(node.status, 'passed')
  assert.equal(node.objective, 'scan', 'objective preserved across terminal update')
  assert.equal(node.progressLine, 'done')
  assert.equal(node.elapsedMs, 3400)
})
