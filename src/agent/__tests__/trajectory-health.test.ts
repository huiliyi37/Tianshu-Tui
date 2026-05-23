import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { assessTrajectoryHealth } from '../trajectory-health.js'

describe('trajectory-health', () => {
  it('returns healthy for pro model regardless of failures', () => {
    const result = assessTrajectoryHealth({
      recentEvents: [
        { status: 'failed', turn: 1 },
        { status: 'failed', turn: 2 },
        { status: 'failed', turn: 3 },
      ],
      currentTurn: 4,
      currentModel: 'pro',
    })
    assert.equal(result, 'healthy')
  })

  it('returns escalate for 3 consecutive failures', () => {
    const result = assessTrajectoryHealth({
      recentEvents: [
        { status: 'passed', turn: 1 },
        { status: 'failed', turn: 2 },
        { status: 'failed', turn: 3 },
        { status: 'failed', turn: 4 },
      ],
      currentTurn: 5,
      currentModel: 'flash',
    })
    assert.equal(result, 'escalate')
  })

  it('returns healthy when few events', () => {
    const result = assessTrajectoryHealth({
      recentEvents: [{ status: 'failed', turn: 1 }],
      currentTurn: 2,
      currentModel: 'flash',
    })
    assert.equal(result, 'healthy')
  })

  it('returns degrading for >60% failure rate in last 8', () => {
    const result = assessTrajectoryHealth({
      recentEvents: [
        { status: 'failed', turn: 1 },
        { status: 'failed', turn: 2 },
        { status: 'passed', turn: 3 },
        { status: 'failed', turn: 4 },
        { status: 'passed', turn: 5 },
        { status: 'failed', turn: 6 },
        { status: 'failed', turn: 7 },
        { status: 'passed', turn: 8 },
      ],
      currentTurn: 9,
      currentModel: 'flash',
    })
    assert.equal(result, 'degrading')
  })

  it('returns healthy when failure rate is low', () => {
    const result = assessTrajectoryHealth({
      recentEvents: [
        { status: 'passed', turn: 1 },
        { status: 'passed', turn: 2 },
        { status: 'failed', turn: 3 },
        { status: 'passed', turn: 4 },
        { status: 'passed', turn: 5 },
      ],
      currentTurn: 6,
      currentModel: 'flash',
    })
    assert.equal(result, 'healthy')
  })
})
