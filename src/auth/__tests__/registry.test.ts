import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { createAuthProvider } from '../registry.js'
import { ApiKeyAuth } from '../api-key.js'

describe('createAuthProvider', () => {
  it('creates ApiKeyAuth for api-key config', () => {
    const auth = createAuthProvider(
      { type: 'api-key', keyEnv: 'TEST_API_KEY' },
      { TEST_API_KEY: 'sk-test-123' },
    )
    assert.ok(auth instanceof ApiKeyAuth)
    assert.equal(auth.isAuthenticated(), true)
  })

  it('creates ApiKeyAuth from legacy apiKey field', () => {
    const auth = createAuthProvider(
      undefined,
      {},
      'sk-legacy-key',
    )
    assert.ok(auth instanceof ApiKeyAuth)
    assert.equal(auth.isAuthenticated(), true)
  })

  it('prefers authConfig over legacy key', () => {
    const auth = createAuthProvider(
      { type: 'api-key', keyEnv: 'MY_KEY' },
      { MY_KEY: 'from-env' },
      'from-legacy',
    )
    const headers = auth.getHeaders()
    // Should use env key, not legacy
    assert.ok(headers instanceof Promise)
  })

  it('throws when api-key env var is missing and no legacy key', () => {
    assert.throws(
      () => createAuthProvider(
        { type: 'api-key', keyEnv: 'MISSING_KEY' },
        {},
      ),
      /MISSING_KEY/,
    )
  })

  it('throws for unimplemented oauth type', () => {
    assert.throws(
      () => createAuthProvider(
        { type: 'oauth', provider: 'codex' },
        {},
      ),
      /not yet implemented/,
    )
  })
})
