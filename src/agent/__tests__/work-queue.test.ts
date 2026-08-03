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

  it('conditional edge: skip — failed dependency keeps task unrunnable（收编 #6）', () => {
    const q = new WorkOrderQueue()
    const a = order('a')
    const b = { ...order('b'), dependencies: [{ dependsOn: 'a', onFailure: 'skip' as const }] }
    q.enqueue(a)
    q.enqueue(b)

    // a 失败 → b 永远不可运行（skip 语义：不执行，清扫时标 skipped）
    const deqA = q.dequeue()!
    q.markInFlight(deqA)
    q.markFailed(deqA)
    assert.equal(q.dequeue(), undefined)
    assert.equal(q.pending().length, 1)
  })

  it('conditional edge: alternate — failed primary falls back to alternate id（收编 #6）', () => {
    const q = new WorkOrderQueue()
    const a = order('a')
    const alt = order('alt')
    const b = { ...order('b'), dependencies: [{ dependsOn: 'a', onFailure: 'alternate' as const, alternateOrderId: 'alt' }] }
    q.enqueue(a)
    q.enqueue(alt)
    q.enqueue(b)

    const deqA = q.dequeue()!
    q.markInFlight(deqA)
    q.markFailed(deqA)
    // alternate 未完成 → b 仍不可运行；alt 出队
    const deqAlt = q.dequeue()!
    assert.equal(deqAlt.id, 'alt')
    q.markInFlight(deqAlt)
    q.markCompleted({ id: 'alt' })
    // alternate 完成 → b 可运行
    assert.equal(q.dequeue()?.id, 'b')
  })

  it('conditional edge: alternate also failed → task stays unrunnable（收编 #6）', () => {
    const q = new WorkOrderQueue()
    const a = order('a')
    const alt = order('alt')
    const b = { ...order('b'), dependencies: [{ dependsOn: 'a', onFailure: 'alternate' as const, alternateOrderId: 'alt' }] }
    q.enqueue(a)
    q.enqueue(alt)
    q.enqueue(b)

    const deqA = q.dequeue()!
    q.markInFlight(deqA)
    q.markFailed(deqA)
    const deqAlt = q.dequeue()!
    q.markInFlight(deqAlt)
    q.markFailed(deqAlt)
    assert.equal(q.dequeue(), undefined)
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

  it('affinity: same priority dequeues same-authority order next（收编 #4）', () => {
    const q = new WorkOrderQueue()
    const a = order('a')
    const b = { ...order('b'), authority: 'yaoguang' }
    const c = { ...order('c'), authority: 'yaoguang' }
    const d = { ...order('d'), authority: 'tianji' }

    q.enqueue(a, 0)
    q.enqueue(b, 0)
    q.enqueue(c, 0)
    q.enqueue(d, 0)

    // 无亲和锚 → 入队序
    assert.equal(q.dequeue()?.id, 'a')
    // 锚 undefined → 无匹配 → 入队序
    assert.equal(q.dequeue()?.id, 'b')
    // 锚 yaoguang → c 亲和优先于 d
    assert.equal(q.dequeue()?.id, 'c')
    assert.equal(q.dequeue()?.id, 'd')
  })

  it('affinity: does not cross priority boundary（tie-breaker only）', () => {
    const q = new WorkOrderQueue()
    const hi = { ...order('hi'), authority: 'yaoguang' }
    const same = { ...order('same'), authority: 'tianji' }
    const low = { ...order('low'), authority: 'yaoguang' }

    q.enqueue(hi, 10)
    q.enqueue(same, 10)
    q.enqueue(low, 0)

    assert.equal(q.dequeue()?.id, 'hi')
    // 同 priority(10) 档内找 yaoguang → 无（same 是 tianji）→ 入队序
    assert.equal(q.dequeue()?.id, 'same')
    // 锚 tianji → 同档无 → low
    assert.equal(q.dequeue()?.id, 'low')
  })

  it('hasFileConflict allows two read-only orders sharing files', () => {
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

    // 只读 + 只读并行检查同一快照是安全的（galaxy 多视角 fan-out 依赖此语义）
    assert.equal(q.hasFileConflict(b), false)
  })

  it('hasFileConflict serializes when either side can write', () => {
    const q = new WorkOrderQueue()
    const writer = {
      ...createReadOnlyWorkOrder({
        id: 'w', parentTurnId: 't', kind: 'patch_proposal', profile: 'patcher',
        objective: 'W', scope: { files: ['src/agent/loop.ts'] },
      }),
      profile: 'patcher',
    }
    const reader = createReadOnlyWorkOrder({
      id: 'r', parentTurnId: 't', kind: 'code_search', profile: 'code_scout',
      objective: 'R', scope: { files: ['src/agent/loop.ts'] },
    })

    q.enqueue(writer)
    q.markInFlight(q.dequeue()!)
    // 在飞写工 × 待派只读 → 冲突（读移动靶）；反向（只读在飞 × 写工待派）同样序列化
    assert.equal(q.hasFileConflict(reader), true)
    assert.equal(q.hasFileConflict({ ...writer, id: 'w2' }), true)
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

  it('A3: markFailed records the failure without satisfying dependents', () => {
    const q = new WorkOrderQueue()
    const parent = order('parent')
    const child = order('child', undefined, ['parent'])

    q.enqueue(parent)
    q.enqueue(child)

    const dequeued = q.dequeue()!
    assert.equal(dequeued.id, 'parent')
    q.markInFlight(dequeued)
    q.markFailed(dequeued)

    // The failed parent is tracked as failed, NOT completed.
    assert.equal(q.hasFailed('parent'), true)
    assert.equal(q.isCompleted('parent'), false)
    // The child must NOT become schedulable on a failed dependency.
    assert.equal(q.dequeue(), undefined)
    // ...and it remains visible in pending() for the post-drain blocked sweep.
    assert.deepEqual(q.pending().map(o => o.id), ['child'])
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

  // ── cancelPending / inFlight ──

  it('cancelPending removes matching orders and marks them failed', () => {
    const q = new WorkOrderQueue()
    const a = order('a')
    const b = order('b')
    const c = order('c')
    q.enqueue(a)
    q.enqueue(b)
    q.enqueue(c)

    const cancelled = q.cancelPending(o => o.id === 'a' || o.id === 'b')
    assert.equal(cancelled.length, 2)
    assert.deepEqual(cancelled.map(o => o.id), ['a', 'b'])
    assert.equal(q.size(), 1)
    assert.ok(q.hasFailed('a'))
    assert.ok(q.hasFailed('b'))
    assert.ok(!q.hasFailed('c'))
  })

  it('cancelPending does not affect in-flight orders', () => {
    const q = new WorkOrderQueue()
    const a = order('a')
    const b = order('b')
    q.enqueue(a)
    q.enqueue(b)

    const deqA = q.dequeue()!
    q.markInFlight(deqA)

    const cancelled = q.cancelPending(() => true)
    assert.equal(cancelled.length, 1)
    assert.equal(cancelled[0]!.id, 'b')
    assert.equal(q.inFlight().length, 1)
    assert.equal(q.inFlight()[0]!.id, 'a')
  })

  it('dependent marked unrunnable after dependency cancelled', () => {
    const q = new WorkOrderQueue()
    const parent = order('parent')
    const child = order('child', undefined, ['parent'])
    q.enqueue(parent)
    q.enqueue(child)

    q.cancelPending(o => o.id === 'parent')
    assert.equal(q.dequeue(), undefined)
    assert.equal(q.pending().length, 1)
  })

  it('inFlight returns empty when nothing is in flight', () => {
    const q = new WorkOrderQueue()
    assert.deepEqual(q.inFlight(), [])
  })

  it('cancelPending with no match returns empty array', () => {
    const q = new WorkOrderQueue()
    q.enqueue(order('a'))
    const cancelled = q.cancelPending(() => false)
    assert.equal(cancelled.length, 0)
    assert.equal(q.size(), 1)
  })
})
