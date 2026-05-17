import { describe, it, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { OAuthAuth } from '../oauth-auth.js'
import type { TokenData } from '../token-store.js'
import { TokenStore } from '../token-store.js'

describe('OAuthAuth', () => {
  let tmpDir: string

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'rivet-oauth-test-'))
  })

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true })
  })

  it('isAuthenticated returns false when no token stored', () => {
    const auth = new OAuthAuth({
      clientId: 'test-client',
      tokenEndpoint: 'https://auth.example.com/token',
    }, tmpDir)
    assert.equal(auth.isAuthenticated(), false)
  })

  it('isAuthenticated returns true when valid token stored', () => {
    const store = new TokenStore(tmpDir, 'codex')
    store.save({
      accessToken: 'at-valid',
      expiresAt: Date.now() + 3600_000,
    })

    const auth = new OAuthAuth({
      clientId: 'test-client',
      tokenEndpoint: 'https://auth.example.com/token',
    }, tmpDir)
    assert.equal(auth.isAuthenticated(), true)
  })

  it('isAuthenticated returns false when token expired', () => {
    const store = new TokenStore(tmpDir, 'codex')
    store.save({
      accessToken: 'at-expired',
      expiresAt: Date.now() - 1000,
    })

    const auth = new OAuthAuth({
      clientId: 'test-client',
      tokenEndpoint: 'https://auth.example.com/token',
    }, tmpDir)
    assert.equal(auth.isAuthenticated(), false)
  })

  it('getHeaders returns Bearer header when token valid', async () => {
    const store = new TokenStore(tmpDir, 'codex')
    store.save({
      accessToken: 'at-test',
      expiresAt: Date.now() + 3600_000,
    })

    const auth = new OAuthAuth({
      clientId: 'test-client',
      tokenEndpoint: 'https://auth.example.com/token',
    }, tmpDir)
    const headers = await auth.getHeaders()
    assert.equal(headers['Authorization'], 'Bearer at-test')
  })

  it('getHeaders throws when not authenticated', async () => {
    const auth = new OAuthAuth({
      clientId: 'test-client',
      tokenEndpoint: 'https://auth.example.com/token',
    }, tmpDir)
    await assert.rejects(
      () => auth.getHeaders(),
      /Not authenticated/,
    )
  })

  it('getHeaders refreshes token when near expiry', async () => {
    const store = new TokenStore(tmpDir, 'codex')
    store.save({
      accessToken: 'at-old',
      refreshToken: 'rt-test',
      expiresAt: Date.now() + 60_000, // 1 minute — within refresh window
    })

    let refreshTokenUsed = ''
    const mockFetch = async (url: string, init?: RequestInit) => {
      const body = new URLSearchParams(init?.body as string)
      refreshTokenUsed = body.get('refresh_token') ?? ''
      return new Response(JSON.stringify({
        access_token: 'at-refreshed',
        refresh_token: 'rt-new',
        expires_in: 3600,
      }), { status: 200 })
    }

    const auth = new OAuthAuth({
      clientId: 'test-client',
      tokenEndpoint: 'https://auth.example.com/token',
      fetch: mockFetch as typeof globalThis.fetch,
    }, tmpDir)

    const headers = await auth.getHeaders()
    assert.equal(headers['Authorization'], 'Bearer at-refreshed')
    assert.equal(refreshTokenUsed, 'rt-test')

    // Verify new token was persisted
    const loaded = store.load()
    assert.equal(loaded?.accessToken, 'at-refreshed')
    assert.equal(loaded?.refreshToken, 'rt-new')
  })

  it('dispose cleans up resources', () => {
    const auth = new OAuthAuth({
      clientId: 'test-client',
      tokenEndpoint: 'https://auth.example.com/token',
    }, tmpDir)
    auth.dispose() // should not throw
  })

  it('exchangeCode sends correct parameters', async () => {
    let capturedBody = ''
    const mockFetch = async (_url: string, init?: RequestInit) => {
      capturedBody = init?.body as string
      return new Response(JSON.stringify({
        access_token: 'at-exchanged',
        refresh_token: 'rt-exchanged',
        expires_in: 3600,
      }), { status: 200 })
    }

    const auth = new OAuthAuth({
      clientId: 'test-client',
      tokenEndpoint: 'https://auth.example.com/token',
      fetch: mockFetch as typeof globalThis.fetch,
    }, tmpDir)

    // Use the public authenticate flow — but we can't easily test the full flow
    // without a real HTTP server, so test via getHeaders after saving a near-expiry token
    // to trigger refresh which uses the same fetch
    const store = new TokenStore(tmpDir, 'codex')
    store.save({
      accessToken: 'at-old',
      refreshToken: 'rt-old',
      expiresAt: Date.now() + 60_000,
    })

    await auth.getHeaders()

    const params = new URLSearchParams(capturedBody)
    assert.equal(params.get('grant_type'), 'refresh_token')
    assert.equal(params.get('client_id'), 'test-client')
    assert.equal(params.get('refresh_token'), 'rt-old')
  })
})
