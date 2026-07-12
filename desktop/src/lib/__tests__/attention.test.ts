import { test } from 'node:test'
import assert from 'node:assert/strict'
import i18n from '../../i18n/index.ts'
import zhInbox from '../../locales/zh-CN/inbox.json'
import { deriveAttention, deriveReviewQueue, sigOf, taskSig } from '../attention.ts'
import type { SessionRecord, TaskRecord } from '../../runtime/types.ts'

// attention.ts resolves labels via the shared i18n singleton — init it with the
// zh-CN inbox namespace so derived strings match the pre-i18n literals.
if (!i18n.isInitialized) {
  await i18n.init({
    lng: 'zh-CN',
    resources: { 'zh-CN': { inbox: zhInbox } },
    interpolation: { escapeValue: false },
  })
} else {
  i18n.addResourceBundle('zh-CN', 'inbox', zhInbox, true, true)
}

function sess(p: Partial<SessionRecord>): SessionRecord {
  return {
    id: 'id',
    title: undefined,
    cwd: '/a/x',
    status: 'idle',
    pendingApprovals: 0,
    createdAt: 0,
    updatedAt: 0,
    ...p,
  } as SessionRecord
}

test('only actionable sessions become attention items', () => {
  const v = deriveAttention([
    sess({ id: '1', status: 'idle', pendingApprovals: 0 }),
    sess({ id: '2', status: 'running', pendingApprovals: 0 }),
    sess({ id: '3', status: 'completed' }),
    sess({ id: '4', status: 'failed' }),
    sess({ id: '5', status: 'running', pendingApprovals: 2 }),
  ], new Set())
  const ids = v.items.map((i) => i.sessionId).sort()
  assert.deepEqual(ids, ['3', '4', '5'])
})

test('approval sorts before failed before completed', () => {
  const v = deriveAttention([
    sess({ id: 'c', status: 'completed', updatedAt: 9 }),
    sess({ id: 'f', status: 'failed', updatedAt: 9 }),
    sess({ id: 'a', status: 'running', pendingApprovals: 1, updatedAt: 9 }),
  ], new Set())
  assert.deepEqual(v.items.map((i) => i.reason), ['approval', 'failed', 'completed'])
})

test('groups by cwd with basename', () => {
  const v = deriveAttention([
    sess({ id: '1', cwd: '/a/x', status: 'failed' }),
    sess({ id: '2', cwd: '/a/x', status: 'completed' }),
    sess({ id: '3', cwd: '/b/y', status: 'failed' }),
  ], new Set())
  assert.equal(v.groups.length, 2)
  const x = v.groups.find((g) => g.cwd === '/a/x')!
  assert.equal(x.name, 'x')
  assert.equal(x.items.length, 2)
})

test('unseenCount drops as signatures are marked seen', () => {
  const sessions = [sess({ id: '4', status: 'failed' })]
  const all = deriveAttention(sessions, new Set())
  assert.equal(all.unseenCount, 1)
  const seen = new Set([sigOf(sessions[0]!)])
  assert.equal(deriveAttention(sessions, seen).unseenCount, 0)
})

test('detail and section labels resolve through i18n (zh-CN)', () => {
  const v = deriveAttention([sess({ id: '5', status: 'running', pendingApprovals: 2 })], new Set())
  assert.equal(v.items[0]!.detail, '2 待审批')
  const q = deriveReviewQueue([sess({ id: 'f', status: 'failed' })], [], new Set())
  assert.equal(q.sections[0]!.label, '失败')
})

test('signature changes when status/approvals change → re-surfaces', () => {
  const a = sigOf({ id: '1', status: 'running', pendingApprovals: 0 })
  const b = sigOf({ id: '1', status: 'running', pendingApprovals: 1 })
  const c = sigOf({ id: '1', status: 'failed', pendingApprovals: 0 })
  assert.notEqual(a, b)
  assert.notEqual(a, c)
})

// ── deriveReviewQueue (Wave 4) ──────────────────────────────────────

function task(p: Partial<TaskRecord>): TaskRecord {
  return {
    id: 't1',
    prompt: 'run nightly checks',
    source: 'cron',
    status: 'completed',
    createdAt: '2026-01-01T00:00:00Z',
    scheduledTaskId: 'cron_a',
    ...p,
  } as TaskRecord
}

test('review queue: terminal automation runs become first-class items', () => {
  const q = deriveReviewQueue([], [
    task({ id: 't1', status: 'completed', sessionId: 's1', result: { summary: 'all green', changedFiles: [] } }),
    task({ id: 't2', status: 'failed', error: 'boom' }),
    task({ id: 't3', status: 'running' }), // non-terminal — excluded
    task({ id: 't4', status: 'completed', scheduledTaskId: undefined }), // not automation — excluded
  ], new Set())
  const auto = q.sections.find((s) => s.id === 'automation')!
  assert.equal(auto.items.length, 2)
  assert.ok(auto.items.every((i) => i.kind === 'automation'))
  const ok = auto.items.find((i) => i.taskId === 't1')!
  assert.ok(ok.detail.includes('all green'))
  assert.equal(ok.sessionId, 's1')
})

test('review queue: automation-produced session is deduped from session groups', () => {
  const q = deriveReviewQueue(
    [sess({ id: 's1', status: 'completed', updatedAt: 5 })],
    [task({ id: 't1', status: 'completed', sessionId: 's1' })],
    new Set(),
  )
  const completed = q.sections.find((s) => s.id === 'completed')
  assert.equal(completed, undefined, 'session item absorbed by automation entry')
  assert.equal(q.items.length, 1)
})

test('review queue: pending approval wins over automation dedup', () => {
  const q = deriveReviewQueue(
    [sess({ id: 's1', status: 'running', pendingApprovals: 1, updatedAt: 5 })],
    [task({ id: 't1', status: 'completed', sessionId: 's1' })],
    new Set(),
  )
  const approval = q.sections.find((s) => s.id === 'approval')!
  assert.equal(approval.items.length, 1)
})

test('review queue: sections ordered approval → automation → failed → completed', () => {
  const q = deriveReviewQueue(
    [
      sess({ id: 'a', status: 'running', pendingApprovals: 1 }),
      sess({ id: 'f', status: 'failed' }),
      sess({ id: 'c', status: 'completed' }),
    ],
    [task({ id: 't1', status: 'completed' })],
    new Set(),
  )
  assert.deepEqual(q.sections.map((s) => s.id), ['approval', 'automation', 'failed', 'completed'])
})

test('review queue: taskSig re-surfaces when task status changes', () => {
  assert.notEqual(taskSig({ id: 't1', status: 'running' }), taskSig({ id: 't1', status: 'completed' }))
  const seen = new Set([taskSig({ id: 't1', status: 'completed' })])
  const q = deriveReviewQueue([], [task({ id: 't1', status: 'completed' })], seen)
  assert.equal(q.unseenCount, 0)
})

// ── active session exclusion (bugfix: inbox noise from sessions you're watching) ──

test('review queue: active session excluded from queue', () => {
  const q = deriveReviewQueue(
    [
      sess({ id: 'active', status: 'completed', updatedAt: 9 }),
      sess({ id: 'bg', status: 'completed', updatedAt: 9 }),
    ],
    [],
    new Set(),
    'active',
  )
  assert.equal(q.items.length, 1)
  assert.equal(q.items[0]!.sessionId, 'bg')
})

test('review queue: null activeSessionId keeps all sessions', () => {
  const q = deriveReviewQueue(
    [sess({ id: 's1', status: 'completed', updatedAt: 9 })],
    [],
    new Set(),
    null,
  )
  assert.equal(q.items.length, 1)
})
