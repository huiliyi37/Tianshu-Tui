import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { shouldRefresh, type TokenData } from '../refresh.js'

describe('shouldRefresh', () => {
  it('returns true when token expires in < 5 minutes', () => {
    const token: TokenData = {
      accessToken: 'at',
      expiresAt: Date.now() + 4 * 60_000,
    }
    assert.equal(shouldRefresh(token), true)
  })

  it('returns false when token has > 5 minutes remaining', () => {
    const token: TokenData = {
      accessToken: 'at',
      expiresAt: Date.now() + 30 * 60_000,
    }
    assert.equal(shouldRefresh(token), false)
  })

  it('returns true when token is already expired', () => {
    const token: TokenData = {
      accessToken: 'at',
      expiresAt: Date.now() - 1000,
    }
    assert.equal(shouldRefresh(token), true)
  })

  it('returns false at exact 5 minute boundary', () => {
    const token: TokenData = {
      accessToken: 'at',
      expiresAt: Date.now() + 5 * 60_000 + 100, // just over 5 min
    }
    assert.equal(shouldRefresh(token), false)
  })
})
