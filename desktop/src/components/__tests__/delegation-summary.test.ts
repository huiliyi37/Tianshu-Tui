import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { DelegationNode } from '../../runtime/types'
import { summarizeDelegation } from '../DelegationTree.tsx'

function node(workerId: string, status: string): DelegationNode {
  return { workerId, objective: '', status, updatedAt: 0 }
}

test('summarizeDelegation: empty → all zero', () => {
  const s = summarizeDelegation({})
  assert.deepEqual(s, { total: 0, done: 0, running: 0, attention: 0 })
})

test('summarizeDelegation: counts passed + completed as done', () => {
  const s = summarizeDelegation({
    a: node('a', 'passed'),
    b: node('b', 'completed'),
  })
  assert.equal(s.total, 2)
  assert.equal(s.done, 2)
  assert.equal(s.running, 0)
  assert.equal(s.attention, 0)
})

test('summarizeDelegation: counts running', () => {
  const s = summarizeDelegation({
    a: node('a', 'running'),
    b: node('b', 'running'),
    c: node('c', 'passed'),
  })
  assert.equal(s.total, 3)
  assert.equal(s.running, 2)
  assert.equal(s.done, 1)
  assert.equal(s.attention, 0)
})

test('summarizeDelegation: blocked/escalated/failed count as attention', () => {
  const s = summarizeDelegation({
    a: node('a', 'blocked'),
    b: node('b', 'escalated'),
    c: node('c', 'failed'),
  })
  assert.equal(s.total, 3)
  assert.equal(s.attention, 3)
  assert.equal(s.done, 0)
  assert.equal(s.running, 0)
})

test('summarizeDelegation: mixed fleet', () => {
  const s = summarizeDelegation({
    a: node('a', 'running'),
    b: node('b', 'passed'),
    c: node('c', 'completed'),
    d: node('d', 'blocked'),
    e: node('e', 'failed'),
    f: node('f', 'idle'),
  })
  assert.equal(s.total, 6)
  assert.equal(s.done, 2)
  assert.equal(s.running, 1)
  assert.equal(s.attention, 2)
})
