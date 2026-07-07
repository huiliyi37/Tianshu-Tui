import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { ApiKeyAuth } from '../api-key.js'

describe('ApiKeyAuth', () => {
  it('returns Authorization header with Bearer token', async () => {
    const auth = new ApiKeyAuth('sk-test-123')
    const headers = await auth.getHeaders()
    assert.equal(headers['Authorization'], 'Bearer sk-test-123')
  })

  it('isAuthenticated returns true when key is set', () => {
    const auth = new ApiKeyAuth('sk-test')
    assert.equal(auth.isAuthenticated(), true)
  })

  it('isAuthenticated returns false when key is empty', () => {
    const auth = new ApiKeyAuth('')
    assert.equal(auth.isAuthenticated(), false)
  })

  it('authenticate is a no-op for API key auth', async () => {
    const auth = new ApiKeyAuth('sk-test')
    await auth.authenticate()
  })

  it('dispose is a no-op', () => {
    const auth = new ApiKeyAuth('sk-test')
    auth.dispose()
  })
})
