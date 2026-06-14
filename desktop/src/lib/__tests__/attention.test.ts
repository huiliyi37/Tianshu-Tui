import { test } from 'node:test'
import assert from 'node:assert/strict'
import { deriveAttention, sigOf } from '../attention.ts'
import type { SessionRecord } from '../../runtime/types.ts'

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

test('signature changes when status/approvals change → re-surfaces', () => {
  const a = sigOf({ id: '1', status: 'running', pendingApprovals: 0 })
  const b = sigOf({ id: '1', status: 'running', pendingApprovals: 1 })
  const c = sigOf({ id: '1', status: 'failed', pendingApprovals: 0 })
  assert.notEqual(a, b)
  assert.notEqual(a, c)
})
