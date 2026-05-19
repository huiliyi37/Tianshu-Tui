import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { TaskBoard } from '../task-board.js'
import { WorkOrderQueue } from '../work-queue.js'
import { createReadOnlyWorkOrder } from '../work-order.js'

function makeOrder(id: string, objective = `Objective for ${id}`, domain: string = 'backend') {
  return createReadOnlyWorkOrder({
    id,
    parentTurnId: 'turn_1',
    kind: 'code_search',
    profile: 'code_scout',
    objective,
    scope: { files: [`src/${id}.ts`] },
    domain: domain as never,
  })
}

describe('TaskBoard', () => {
  it('receives task:added when queue enqueues', () => {
    const queue = new WorkOrderQueue()
    const board = new TaskBoard(queue)
    const events: string[] = []
    board.on(e => events.push(e.type))

    queue.enqueue(makeOrder('a'))

    assert.deepEqual(events, ['task:added'])
    assert.equal(board.getAllTasks().length, 1)
  })

  it('receives task:started when queue dequeues', () => {
    const queue = new WorkOrderQueue()
    const board = new TaskBoard(queue)
    const events: string[] = []
    board.on(e => events.push(e.type))

    queue.enqueue(makeOrder('a'))
    const dequeued = queue.dequeue()!
    queue.markInFlight(dequeued)

    assert.ok(events.includes('task:started'))
    const task = board.getTask('a')
    assert.ok(task)
    assert.equal(task.status, 'running')
  })

  it('receives task:completed when queue marks completed', () => {
    const queue = new WorkOrderQueue()
    const board = new TaskBoard(queue)
    const events: string[] = []
    board.on(e => events.push(e.type))

    queue.enqueue(makeOrder('a'))
    const dequeued = queue.dequeue()!
    queue.markInFlight(dequeued)
    queue.markCompleted(dequeued)

    assert.ok(events.includes('task:completed'))
    const task = board.getTask('a')
    assert.ok(task)
    assert.equal(task.status, 'completed')
  })

  it('receives task:failed when queue marks failed', () => {
    const queue = new WorkOrderQueue()
    const board = new TaskBoard(queue)
    const events: string[] = []
    board.on(e => events.push(e.type))

    queue.enqueue(makeOrder('a'))
    const dequeued = queue.dequeue()!
    queue.markInFlight(dequeued)
    queue.markFailed(dequeued)

    assert.ok(events.includes('task:failed'))
    const task = board.getTask('a')
    assert.ok(task)
    assert.equal(task.status, 'failed')
  })

  it('getTasksByDomain filters by domain', () => {
    const queue = new WorkOrderQueue()
    const board = new TaskBoard(queue)

    queue.enqueue(makeOrder('a', 'Backend task', 'backend'))
    queue.enqueue(makeOrder('b', 'Frontend task', 'frontend'))

    assert.equal(board.getTasksByDomain('backend').length, 1)
    assert.equal(board.getTasksByDomain('frontend').length, 1)
    assert.equal(board.getTasksByDomain('tests').length, 0)
  })

  it('getProgress counts correctly', () => {
    const queue = new WorkOrderQueue()
    const board = new TaskBoard(queue)

    queue.enqueue(makeOrder('a'))
    queue.enqueue(makeOrder('b'))
    queue.enqueue(makeOrder('c'))

    const a = queue.dequeue()!
    queue.markInFlight(a)
    queue.markCompleted(a)

    const b = queue.dequeue()!
    queue.markInFlight(b)
    queue.markFailed(b)

    // c is still pending
    const progress = board.getProgress()
    assert.equal(progress.total, 3)
    assert.equal(progress.completed, 1)
    assert.equal(progress.failed, 1)
    assert.equal(progress.running, 0) // c was never dequeued
  })

  it('on() returns unsubscribe function', () => {
    const queue = new WorkOrderQueue()
    const board = new TaskBoard(queue)
    const events: string[] = []
    const unsub = board.on(e => events.push(e.type))

    queue.enqueue(makeOrder('a'))
    unsub()
    queue.enqueue(makeOrder('b'))

    assert.equal(events.length, 1) // only 'a' event
  })
})
