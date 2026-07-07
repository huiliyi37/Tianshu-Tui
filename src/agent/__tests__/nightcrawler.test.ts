import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { Nightcrawler } from '../nightcrawler.js'

describe('Nightcrawler', () => {
  it('submits and completes a task', async () => {
    const nc = new Nightcrawler({
      execute: async () => 'done',
    })
    const id = nc.submit('test task', 'do something')
    // Wait for async execution
    await new Promise(r => nc.once('completed', r))
    const task = nc.getTask(id)
    assert.equal(task?.status, 'completed')
    assert.equal(task?.result, 'done')
  })

  it('handles task failure', async () => {
    const nc = new Nightcrawler({
      execute: async () => { throw new Error('boom') },
    })
    const id = nc.submit('failing task', 'fail')
    await new Promise(r => nc.once('failed', r))
    const task = nc.getTask(id)
    assert.equal(task?.status, 'failed')
    assert.equal(task?.error, 'boom')
  })

  it('cancels a queued task', () => {
    const nc = new Nightcrawler({
      maxConcurrent: 1,
      execute: () => new Promise(() => {}), // never resolves
    })
    nc.submit('task1', 'p1') // starts running (slot 1)
    const id2 = nc.submit('task2', 'p2') // queued
    assert.equal(nc.getTask(id2)?.status, 'queued')
    assert.ok(nc.cancel(id2))
    assert.equal(nc.getTask(id2)?.status, 'cancelled')
    // cleanup running task
    nc.cancel(nc.listTasks().find(t => t.status === 'running')!.id)
  })

  it('respects maxConcurrent', () => {
    const nc = new Nightcrawler({
      maxConcurrent: 2,
      execute: () => new Promise(() => {}),
    })
    nc.submit('t1', 'p1')
    nc.submit('t2', 'p2')
    nc.submit('t3', 'p3')
    const stats = nc.stats()
    assert.equal(stats.running, 2)
    assert.equal(stats.queued, 1)
    // cleanup
    nc.cancel('bg-1')
    nc.cancel('bg-2')
    nc.cancel('bg-3')
  })

  it('times out a long-running task', async () => {
    const nc = new Nightcrawler({
      defaultTimeoutMs: 50,
      execute: () => new Promise(() => {}), // never resolves
    })
    const id = nc.submit('slow task', 'wait forever')
    await new Promise(r => nc.once('timeout', r))
    assert.equal(nc.getTask(id)?.status, 'timeout')
  })

  it('checkpoints and resumes', async () => {
    let attempt = 0
    const nc = new Nightcrawler({
      execute: async (task) => {
        attempt++
        if (attempt === 1) {
          nc.checkpoint(task.id, 'state-at-turn-3', 3)
          throw new Error('transient')
        }
        return `resumed from ${task.checkpoint}`
      },
    })
    const id = nc.submit('resumable', 'do work')
    await new Promise(r => nc.once('failed', r))
    assert.equal(nc.getTask(id)?.checkpoint, 'state-at-turn-3')
    nc.resume(id)
    await new Promise(r => nc.once('completed', r))
    assert.equal(nc.getTask(id)?.result, 'resumed from state-at-turn-3')
  })
})
