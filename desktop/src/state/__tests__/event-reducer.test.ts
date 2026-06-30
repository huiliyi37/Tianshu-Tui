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

test('tool_result prefers uiContent over the model-facing result for display', () => {
  seq = 0
  const s = fold([
    ev('tool_result', {
      name: 'ask_user_question',
      result: '[Awaiting your response…]',
      uiContent: 'Which database?\n\n  1. Postgres\n  2. SQLite',
    }),
  ])
  const block = s.blocks.find((b) => b.kind === 'result')
  assert.ok(block)
  assert.ok(block!.text.includes('Which database?'))
  assert.ok(block!.text.includes('1. Postgres'))
  assert.ok(!block!.text.includes('Awaiting'))
})

test('tool_result falls back to result when uiContent is absent', () => {
  seq = 0
  const s = fold([ev('tool_result', { name: 'bash', result: 'ok' })])
  const block = s.blocks.find((b) => b.kind === 'result')
  assert.equal(block!.text, 'ok')
})

test('approval_required sets pending, approval_resolved clears it', () => {
  seq = 0
  const after = fold([ev('approval_required', { requestId: 'r1', toolName: 'bash', input: {} })])
  assert.equal(after.pendingApproval?.requestId, 'r1')
  const resolved = eventReducer(after, { type: 'event', event: ev('approval_resolved', { requestId: 'r1' }) })
  assert.equal(resolved.pendingApproval, null)
})

test('intent_note appends a non-blocking timeline block (no pending state)', () => {
  seq = 0
  const s = fold([ev('intent_note', {
    summary: 'about to refactor',
    confidence: 0.4,
    warnings: ['high commit threshold'],
    title: '天权 · 方向提示',
    reasons: ['我对当前方向把握偏低'],
    action: '已记录，我会继续执行（必要时先自检一步）',
    steerHint: '想改方向就直接在下面打字告诉我',
  })])
  const block = s.blocks.find((b) => b.kind === 'intent_note')
  assert.ok(block, 'intent_note should produce a timeline block')
  assert.equal(block!.note?.title, '天权 · 方向提示')
  assert.deepEqual(block!.note?.reasons, ['我对当前方向把握偏低'])
  assert.equal(block!.note?.action, '已记录，我会继续执行（必要时先自检一步）')
  assert.equal(block!.text, 'about to refactor')
  assert.ok(s.blocksRev > 0)
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

test('T1: final turn_complete adds a turn block with usage metadata', () => {
  seq = 0
  const s = fold([
    ev('text_delta', { text: 'response' }),
    ev('turn_complete', { turnNumber: 2, isFinal: true, usage: { totalTokens: 1500 } }),
  ])
  assert.equal(s.blocks.length, 2)
  assert.equal(s.blocks[1]!.kind, 'turn')
  assert.equal(s.blocks[1]!.turn?.turnNumber, 2)
  assert.equal(s.blocks[1]!.turn?.totalTokens, 1500)
  assert.equal(s.blocks[1]!.turn?.isFinal, true)
})

test('intermediate turn_complete (isFinal=false) draws no divider', () => {
  seq = 0
  const s = fold([
    ev('text_delta', { text: 'partial' }),
    ev('turn_complete', { turnNumber: 1, isFinal: false }),
    ev('tool_use', { name: 'bash' }),
    ev('tool_result', { name: 'bash', result: 'ok' }),
    ev('turn_complete', { turnNumber: 2, isFinal: false }),
  ])
  // A run emits many intermediate completions; only the final one delimits.
  assert.equal(s.blocks.filter((b) => b.kind === 'turn').length, 0)
})

test('final turn_complete with evidence stores completionSummary', () => {
  seq = 0
  const evidence = {
    filesRead: [],
    filesModified: ['src/a.ts'],
    verificationStatus: 'verified',
    verifications: [{ command: 'npm test', status: 'passed', scope: 'full', exitCode: 0, passed: 3, failed: 0, skipped: 0, durationMs: 100 }],
    gate: { state: 'GREEN', label: 'GREEN' },
    impactedFiles: [],
    impactedTests: [],
  }
  const s = fold([
    ev('text_delta', { text: 'done' }),
    ev('turn_complete', { turnNumber: 1, isFinal: true, usage: {}, evidence }),
  ])
  assert.deepEqual(s.completionSummary, evidence)
})

test('final turn_complete strips inline evidence markdown from assistant text', () => {
  seq = 0
  const evidence = {
    filesRead: [],
    filesModified: ['src/a.ts'],
    verificationStatus: 'verified',
    verifications: [],
    gate: { state: 'GREEN', label: 'GREEN' },
    impactedFiles: [],
    impactedTests: [],
  }
  const s = fold([
    ev('text_delta', { text: 'Here is the result.\n---\n## 任务完成总结\n- 改动文件：1\n  - src/a.ts' }),
    ev('turn_complete', { turnNumber: 1, isFinal: true, usage: {}, evidence }),
  ])
  const assistant = s.blocks.find((b) => b.kind === 'assistant')
  assert.equal(assistant?.text, 'Here is the result.')
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

// ── Wave3: rewind anchoring ─────────────────────────────────────────

test('rewind anchorSeq truncates at the exact user block (drops it + after)', () => {
  seq = 0
  const uA = ev('user', { text: 'task A' })
  const a1 = ev('text_delta', { text: 'doing A' })
  const uB = ev('user', { text: 'task B' })
  const a2 = ev('text_delta', { text: 'doing B' })
  const s = fold([
    uA, a1, uB, a2,
    ev('rewind', { prompt: 'task B', anchorSeq: uB.seq }),
  ])
  // u-B and everything after it is dropped; only A's turn survives + marker.
  const kinds = s.blocks.map(b => b.kind)
  assert.deepEqual(kinds, ['user', 'assistant', 'turn'])
  assert.equal(s.blocks[0]!.text, 'task A')
  assert.equal(s.blocks[2]!.text, '⏪ Rewound — message restored to input.')
})

test('rewind anchorSeq disambiguates duplicate prompts (substring heuristic could not)', () => {
  seq = 0
  const u1 = ev('user', { text: 'do it' })
  const d1 = ev('text_delta', { text: 'r1' })
  const u2 = ev('user', { text: 'do it' }) // identical prompt
  const d2 = ev('text_delta', { text: 'r2' })
  // Anchor explicitly to the FIRST occurrence — a text match would hit the last.
  const s = fold([
    u1, d1, u2, d2,
    ev('rewind', { prompt: 'do it', anchorSeq: u1.seq }),
  ])
  assert.deepEqual(s.blocks.map(b => b.kind), ['turn'], 'both turns dropped, only the marker remains')
})

test('rewind falls back to exact full-text match when no anchorSeq (older server)', () => {
  seq = 0
  const u1 = ev('user', { text: 'first' })
  const d1 = ev('text_delta', { text: 'r1' })
  const u2 = ev('user', { text: 'second' })
  const d2 = ev('text_delta', { text: 'r2' })
  const s = fold([
    u1, d1, u2, d2,
    ev('rewind', { prompt: 'second' }), // no anchorSeq
  ])
  // cut at u2 ('second'); first turn survives + marker.
  assert.deepEqual(s.blocks.map(b => b.kind), ['user', 'assistant', 'turn'])
  assert.equal(s.blocks[0]!.text, 'first')
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

test('empty turn_complete (no preceding content) creates no turn block', () => {
  seq = 0
  const s = fold([ev('turn_complete', { turnNumber: 0, isFinal: false })])
  assert.equal(s.blocks.length, 0, 'turn_complete with no preceding content should not create a block')
})

test('consecutive final turn_complete without content between them skips the second', () => {
  seq = 0
  const s = fold([
    ev('user', { text: 'hi' }),
    ev('text_delta', { text: 'hello' }),
    ev('turn_complete', { turnNumber: 0, isFinal: true }),
    ev('turn_complete', { turnNumber: 1, isFinal: true }),
  ])
  const turnBlocks = s.blocks.filter(b => b.kind === 'turn')
  assert.equal(turnBlocks.length, 1, 'second consecutive turn_complete should be filtered')
})

test('plan_mode toggles state and bumps planRev', () => {
  seq = 0
  const on = fold([ev('plan_mode', { state: 'planning' })])
  assert.equal(on.planMode, 'planning')
  assert.equal(on.planRev, 1)
  const off = eventReducer(on, { type: 'event', event: ev('plan_mode', { state: 'off' }) })
  assert.equal(off.planMode, 'off')
  assert.equal(off.planRev, 2)
})

test('plan_submitted bumps planRev and records latest slug', () => {
  seq = 0
  const s = fold([ev('plan_submitted', { slug: 'my-plan', title: 'My Plan' })])
  assert.equal(s.planRev, 1)
  assert.equal(s.latestPlanSlug, 'my-plan')
})

test('events batch coalesces consecutive text_delta into one block (same result as one-by-one)', () => {
  seq = 0
  const batch = [
    ev('text_delta', { text: 'a' }),
    ev('text_delta', { text: 'b' }),
    ev('text_delta', { text: 'c' }),
  ]
  const s = eventReducer(initialEventState, { type: 'events', events: batch })
  assert.equal(s.blocks.length, 1)
  assert.equal(s.blocks[0]!.text, 'abc')
  assert.equal(s.lastSeq, batch[batch.length - 1]!.seq)
})

test('events batch coalesces deltas separately around a tool_use boundary', () => {
  seq = 0
  const batch = [
    ev('text_delta', { text: 'x' }),
    ev('text_delta', { text: 'y' }),
    ev('tool_use', { name: 'bash', input: { cmd: 'ls' } }),
    ev('text_delta', { text: 'z' }),
  ]
  const s = eventReducer(initialEventState, { type: 'events', events: batch })
  assert.equal(s.blocks.length, 3)
  assert.equal(s.blocks[0]!.text, 'xy')
  assert.equal(s.blocks[1]!.kind, 'tool')
  assert.equal(s.blocks[2]!.text, 'z')
})

test('events batch is idempotent: already-folded seqs are dropped before coalescing', () => {
  seq = 0
  const e1 = ev('text_delta', { text: 'hel' })
  const e2 = ev('text_delta', { text: 'lo' })
  const first = eventReducer(initialEventState, { type: 'events', events: [e1, e2] })
  // Replay the same batch plus a fresh delta — folded seqs must not duplicate text.
  const e3 = ev('text_delta', { text: '!' })
  const second = eventReducer(first, { type: 'events', events: [e1, e2, e3] })
  assert.equal(second.blocks.length, 1)
  assert.equal(second.blocks[0]!.text, 'hello!')
})

// I4 — hook_result events are collected and trimmed to the latest 50.
test('hook_result events accumulate and are capped at 50', () => {
  seq = 0
  const events: SessionEvent[] = []
  for (let i = 0; i < 55; i++) {
    events.push(ev('hook_result', { event: 'postTool', results: [{ script: `./${i}.sh`, ok: true, output: '' }] }))
  }
  const s = fold(events)
  assert.equal(s.hookResults.length, 50)
  assert.equal((s.hookResults[0]!.data.results as { script: string }[])[0]!.script, './5.sh')
})
