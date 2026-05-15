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
})
