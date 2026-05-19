import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { WorkOrderQueue } from '../work-queue.js'
import { createReadOnlyWorkOrder } from '../work-order.js'

function order(id: string, dedupeKey?: string, deps: string[] = [], priority = 0) {
  const o = createReadOnlyWorkOrder({
    id,
    parentTurnId: 'turn_1',
    kind: 'code_search',
    profile: 'code_scout',
    objective: `Objective for ${id}`,
    scope: {},
    dependencies: deps,
  })
  return { ...o, dedupeKey: dedupeKey ?? `${id}:default`, _priority: priority }
}

describe('WorkOrderQueue', () => {
  it('enqueues and dequeues items in priority order', () => {
    const q = new WorkOrderQueue()
    const lo = order('lo')
    const hi = order('hi')
    const mid = order('mid')

    q.enqueue(lo, 0)
    q.enqueue(hi, 10)
    q.enqueue(mid, 5)

    assert.equal(q.dequeue()?.id, 'hi')
    assert.equal(q.dequeue()?.id, 'mid')
    assert.equal(q.dequeue()?.id, 'lo')
    assert.equal(q.dequeue(), undefined)
  })

  it('rejects duplicate dedupeKeys when an item is in-flight', () => {
    const q = new WorkOrderQueue()
    const a = order('a', 'file:src/main.tsx')
    const b = order('b', 'file:src/main.tsx')

    q.enqueue(a)
    const dequeued = q.dequeue()!
    q.markInFlight(dequeued)

    assert.equal(q.enqueue(b), false)
    assert.equal(q.size(), 0)
  })

  it('allows the same dedupeKey after in-flight completes', () => {
    const q = new WorkOrderQueue()
    const a = order('a', 'file:src/main.tsx')

    q.enqueue(a)
    const dequeued = q.dequeue()!
    q.markInFlight(dequeued)
    q.markCompleted(a)

    const b = order('b', 'file:src/main.tsx')
    assert.equal(q.enqueue(b), true)
  })

  it('holds items with unmet dependencies', () => {
    const q = new WorkOrderQueue()
    const parent = order('parent')
    const child = order('child', undefined, ['parent'])

    q.enqueue(child)
    assert.equal(q.dequeue(), undefined)

    q.enqueue(parent)
    assert.equal(q.dequeue()?.id, 'parent')

    q.markCompleted(parent)
    assert.equal(q.dequeue()?.id, 'child')
  })

  it('respects max concurrency', () => {
    const q = new WorkOrderQueue(2)
    q.enqueue(order('a', 'a'))
    q.enqueue(order('b', 'b'))
    q.enqueue(order('c', 'c'))

    q.markInFlight(q.dequeue()!)
    q.markInFlight(q.dequeue()!)
    assert.equal(q.dequeue(), undefined)

    q.markCompleted({ id: 'a', dedupeKey: 'a' } as never)
    assert.equal(q.dequeue()?.id, 'c')
  })

  it('skips dependency check for items with no dependencies', () => {
    const q = new WorkOrderQueue()
    q.enqueue(order('free'))
    assert.equal(q.dequeue()?.id, 'free')
  })

  it('emits enqueued events', () => {
    const q = new WorkOrderQueue()
    const events: string[] = []
    q.on(e => events.push(e.type))

    q.enqueue(order('a'))
    assert.deepEqual(events, ['enqueued'])
  })

  it('emits dequeued, completed, failed events', () => {
    const q = new WorkOrderQueue()
    const events: string[] = []
    q.on(e => events.push(e.type))

    q.enqueue(order('a'))
    const dequeued = q.dequeue()!
    q.markInFlight(dequeued)
    q.markCompleted(dequeued)
    q.markFailed(order('b'))

    assert.deepEqual(events, ['enqueued', 'dequeued', 'completed', 'failed'])
  })

  it('on() returns unsubscribe function', () => {
    const q = new WorkOrderQueue()
    const events: string[] = []
    const unsub = q.on(e => events.push(e.type))

    q.enqueue(order('a'))
    unsub()
    q.enqueue(order('b'))

    assert.equal(events.length, 1)
  })

  it('hasFileConflict detects shared files with in-flight orders', () => {
    const q = new WorkOrderQueue()
    const a = createReadOnlyWorkOrder({
      id: 'a', parentTurnId: 't', kind: 'code_search', profile: 'code_scout',
      objective: 'A', scope: { files: ['src/agent/loop.ts'] },
    })
    const b = createReadOnlyWorkOrder({
      id: 'b', parentTurnId: 't', kind: 'code_search', profile: 'code_scout',
      objective: 'B', scope: { files: ['src/agent/loop.ts'] },
    })

    q.enqueue(a)
    const dequeued = q.dequeue()!
    q.markInFlight(dequeued)

    assert.equal(q.hasFileConflict(b), true)
  })

  it('hasFileConflict returns false when no files', () => {
    const q = new WorkOrderQueue()
    const a = createReadOnlyWorkOrder({
      id: 'a', parentTurnId: 't', kind: 'code_search', profile: 'code_scout',
      objective: 'A', scope: {},
    })
    q.enqueue(a)
    q.markInFlight(q.dequeue()!)

    const b = createReadOnlyWorkOrder({
      id: 'b', parentTurnId: 't', kind: 'code_search', profile: 'code_scout',
      objective: 'B', scope: {},
    })
    assert.equal(q.hasFileConflict(b), false)
  })

  it('dequeue skips orders with file conflicts', () => {
    const q = new WorkOrderQueue()
    const a = createReadOnlyWorkOrder({
      id: 'a', parentTurnId: 't', kind: 'code_search', profile: 'code_scout',
      objective: 'A', scope: { files: ['src/agent/loop.ts'] },
    })
    const b = createReadOnlyWorkOrder({
      id: 'b', parentTurnId: 't', kind: 'code_search', profile: 'code_scout',
      objective: 'B', scope: { files: ['src/agent/loop.ts'] },
    })
    const c = createReadOnlyWorkOrder({
      id: 'c', parentTurnId: 't', kind: 'code_search', profile: 'code_scout',
      objective: 'C', scope: { files: ['src/prompt/engine.ts'] },
    })

    q.enqueue(a)
    q.enqueue(b)
    q.enqueue(c)

    // a dequeued first
    const first = q.dequeue()!
    q.markInFlight(first)

    // b has file conflict with a, so c should dequeue
    const second = q.dequeue()!
    assert.equal(second.id, 'c')
  })
})
