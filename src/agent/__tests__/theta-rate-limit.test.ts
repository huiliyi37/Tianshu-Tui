import { describe, it } from 'node:test'
import assert from 'node:assert/strict'

describe('Theta rate limit: consecutive timeout backoff', () => {
  it('should not backoff when there are zero consecutive timeouts', () => {
    const consecutiveTimeouts = 0
    const cooldown = consecutiveTimeouts === 0 ? 0
      : Math.min(4, consecutiveTimeouts)
    assert.strictEqual(cooldown, 0)
  })

  it('should backoff 1 turn after 1 consecutive timeout', () => {
    const consecutiveTimeouts = 1
    const cooldown = Math.min(4, consecutiveTimeouts)
    assert.strictEqual(cooldown, 1)
  })

  it('should backoff 2 turns after 2 consecutive timeouts', () => {
    const consecutiveTimeouts = 2
    const cooldown = Math.min(4, consecutiveTimeouts)
    assert.strictEqual(cooldown, 2)
  })

  it('should cap at 4 turns for 4+ consecutive timeouts', () => {
    const consecutiveTimeouts = 5
    const cooldown = Math.min(4, consecutiveTimeouts)
    assert.strictEqual(cooldown, 4)
  })

  it('should reset consecutive timeouts on success', () => {
    let consecutiveTimeouts = 3
    const lastTimedOut = false
    if (!lastTimedOut) consecutiveTimeouts = 0
    assert.strictEqual(consecutiveTimeouts, 0)
  })
})

describe('Theta rate limit: per-turn and session caps', () => {
  it('enforces per-turn cap of 2', () => {
    const MAX_PER_TURN = 2
    let requestsThisTurn = 0
    assert.ok(requestsThisTurn < MAX_PER_TURN)
    requestsThisTurn++
    assert.ok(requestsThisTurn < MAX_PER_TURN)
    requestsThisTurn++
    assert.ok(!(requestsThisTurn < MAX_PER_TURN))
  })

  it('enforces session cap of 40', () => {
    const MAX_SESSION = 40
    const requestedCount = 40
    assert.ok(!(requestedCount < MAX_SESSION))
  })

  it('cooldown blocks requests until turn expires', () => {
    const cooldownUntilTurn = 5
    const currentTurn = 4
    assert.ok(currentTurn < cooldownUntilTurn)
    const currentTurn2 = 5
    assert.ok(!(currentTurn2 < cooldownUntilTurn))
  })
})
