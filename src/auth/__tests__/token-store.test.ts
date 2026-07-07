import { describe, it, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { TokenStore } from '../token-store.js'

describe('TokenStore', () => {
  let tmpDir: string

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'rivet-auth-test-'))
  })

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true })
  })

  it('saves and loads tokens', () => {
    const store = new TokenStore(tmpDir, 'codex')
    store.save({
      accessToken: 'at-123',
      refreshToken: 'rt-456',
      expiresAt: Date.now() + 3600_000,
    })
    const loaded = store.load()
    assert.equal(loaded?.accessToken, 'at-123')
    assert.equal(loaded?.refreshToken, 'rt-456')
  })

  it('returns null when no tokens saved', () => {
    const store = new TokenStore(tmpDir, 'nonexistent')
    assert.equal(store.load(), null)
  })

  it('creates auth directory if missing', () => {
    const nestedDir = join(tmpDir, 'deep', 'nested')
    const store = new TokenStore(nestedDir, 'codex')
    store.save({ accessToken: 'at', expiresAt: Date.now() })
    assert.ok(existsSync(join(nestedDir, 'codex.json')))
  })

  it('clears tokens', () => {
    const store = new TokenStore(tmpDir, 'codex')
    store.save({ accessToken: 'at', expiresAt: Date.now() })
    store.clear()
    assert.equal(store.load(), null)
  })

  it('persists accountId when provided', () => {
    const store = new TokenStore(tmpDir, 'codex')
    store.save({ accessToken: 'at', expiresAt: Date.now(), accountId: 'acct-123' })
    const loaded = store.load()
    assert.equal(loaded?.accountId, 'acct-123')
  })
})
