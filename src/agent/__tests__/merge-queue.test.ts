/**
 * Tests for MergeQueue — 有序合并队列
 */

import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { MergeQueue, type MergeQueueEntry } from '../merge-queue.js'

function makeEntry(workerId: string, level: import('../conflict-gradient.js').ConflictLevel, priority = 0): MergeQueueEntry {
  return {
    workerId,
    branch: `branch-${workerId}`,
    diff: `diff for ${workerId}`,
    changedFiles: [`${workerId}.ts`],
    conflictLevel: level,
    enqueuedAt: Date.now(),
    priority,
  }
}

describe('MergeQueue', () => {
  it('enqueues and dequeues entries', () => {
    const q = new MergeQueue()
    const entry = makeEntry('w1', 'green')

    assert.equal(q.enqueue(entry), true)
    assert.equal(q.size, 1)

    const dequeued = q.dequeue()
    assert.notEqual(dequeued, undefined)
    assert.equal(dequeued!.workerId, 'w1')
  })

  it('rejects red level entries', () => {
    const q = new MergeQueue()
    const entry = makeEntry('w1', 'red')
    assert.equal(q.enqueue(entry), false)
    assert.equal(q.size, 0)
  })

  it('rejects duplicate entries', () => {
    const q = new MergeQueue()
    q.enqueue(makeEntry('w1', 'green'))
    assert.equal(q.enqueue(makeEntry('w1', 'yellow')), false)
  })

  it('sorts by conflict level (green before yellow before orange)', () => {
    const q = new MergeQueue()
    q.enqueue(makeEntry('w1', 'orange'))
    q.enqueue(makeEntry('w2', 'green'))
    q.enqueue(makeEntry('w3', 'yellow'))

    const first = q.dequeue()
    assert.equal(first!.conflictLevel, 'green')
    const second = q.dequeue()
    assert.equal(second!.conflictLevel, 'yellow')
    const third = q.dequeue()
    assert.equal(third!.conflictLevel, 'orange')
  })

  it('sorts by priority within same level', () => {
    const q = new MergeQueue()
    q.enqueue(makeEntry('w1', 'green', 1))
    q.enqueue(makeEntry('w2', 'green', 5))
    q.enqueue(makeEntry('w3', 'green', 3))

    const first = q.dequeue()
    assert.equal(first!.workerId, 'w2') // priority 5
    const second = q.dequeue()
    assert.equal(second!.workerId, 'w3') // priority 3
  })

  it('marks entries as merged', () => {
    const q = new MergeQueue()
    q.enqueue(makeEntry('w1', 'green'))
    const entry = q.dequeue()!
    q.markMerged(entry.workerId, entry.changedFiles)

    assert.deepEqual(q.getCompletedFiles(), ['w1.ts'])
  })

  it('marks entries as escalated', () => {
    const q = new MergeQueue()
    q.enqueue(makeEntry('w1', 'green'))
    const entry = q.dequeue()!
    q.markEscalated(entry.workerId)

    const all = q.getAll()
    assert.equal(all.length, 0) // removed from queue
  })

  it('removes entries by workerId', () => {
    const q = new MergeQueue()
    q.enqueue(makeEntry('w1', 'green'))
    q.enqueue(makeEntry('w2', 'green'))

    assert.equal(q.remove('w1'), true)
    assert.equal(q.size, 1)
    assert.equal(q.remove('nonexistent'), false)
  })

  it('emits events', () => {
    const q = new MergeQueue()
    const events: string[] = []
    q.on(e => events.push(e.type))

    q.enqueue(makeEntry('w1', 'green'))
    q.dequeue()
    q.remove('w1')

    assert.deepEqual(events, ['enqueued', 'dequeued', 'removed'])
  })

  it('respects maxSize', () => {
    const q = new MergeQueue(2)
    assert.equal(q.enqueue(makeEntry('w1', 'green')), true)
    assert.equal(q.enqueue(makeEntry('w2', 'green')), true)
    assert.equal(q.enqueue(makeEntry('w3', 'green')), false)
  })

  it('getPending returns only pending entries', () => {
    const q = new MergeQueue()
    q.enqueue(makeEntry('w1', 'green'))
    q.enqueue(makeEntry('w2', 'yellow'))
    q.dequeue() // w1 becomes 'merging'

    const pending = q.getPending()
    assert.equal(pending.length, 1)
    assert.equal(pending[0]!.workerId, 'w2')
  })

  it('isEmpty works', () => {
    const q = new MergeQueue()
    assert.equal(q.isEmpty, true)
    q.enqueue(makeEntry('w1', 'green'))
    assert.equal(q.isEmpty, false)
  })
})
