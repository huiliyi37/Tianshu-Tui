import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  beginActivity,
  heartbeatActivity,
  completeActivity,
  clearActivity,
  failActivity,
  createIdleActivity,
} from '../activity-status.js'

describe('activity status lifecycle', () => {
  it('starts idle', () => {
    assert.deepEqual(createIdleActivity(1000), {
      phase: 'idle',
      startedAt: 1000,
      lastEventAt: 1000,
      status: 'idle',
    })
  })

  it('begins an activity with phase, label, size hint, and timestamps', () => {
    const activity = beginActivity(createIdleActivity(1000), 'thinking', 'Thinking', 2000, '12 chars')

    assert.equal(activity.phase, 'thinking')
    assert.equal(activity.label, 'Thinking')
    assert.equal(activity.startedAt, 2000)
    assert.equal(activity.lastEventAt, 2000)
    assert.equal(activity.sizeHint, '12 chars')
    assert.equal(activity.status, 'active')
  })

  it('heartbeats without resetting start time', () => {
    const activity = beginActivity(createIdleActivity(1000), 'tool', 'Running npm test', 2000)
    const next = heartbeatActivity(activity, 5000, { label: 'Running npm test', sizeHint: '3 lines' })

    assert.equal(next.startedAt, 2000)
    assert.equal(next.lastEventAt, 5000)
    assert.equal(next.label, 'Running npm test')
    assert.equal(next.sizeHint, '3 lines')
    assert.equal(next.status, 'active')
  })

  it('completion and failure freeze timestamps', () => {
    const activity = beginActivity(createIdleActivity(1000), 'mcp', 'Waiting for MCP context7', 2000)

    assert.deepEqual(completeActivity(activity, 8000), {
      ...activity,
      completedAt: 8000,
      lastEventAt: 8000,
      status: 'completed',
    })

    assert.deepEqual(failActivity(activity, 9000), {
      ...activity,
      completedAt: 9000,
      lastEventAt: 9000,
      status: 'failed',
    })
  })

  it('clears to idle at the provided time', () => {
    const activity = beginActivity(createIdleActivity(1000), 'streaming', 'Streaming answer', 2000)

    assert.deepEqual(clearActivity(activity, 7000), {
      phase: 'idle',
      startedAt: 7000,
      lastEventAt: 7000,
      status: 'idle',
    })
  })
})
