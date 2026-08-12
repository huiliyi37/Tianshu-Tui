import { describe, it, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { probeProviderKey } from '../key-probe.js'
import { mock } from 'node:test'

describe('probeProviderKey', () => {
  let originalFetch: typeof global.fetch

  beforeEach(() => {
    originalFetch = global.fetch
  })

  afterEach(() => {
    global.fetch = originalFetch
  })

  it('returns ok=true for a 200 response', async () => {
    global.fetch = mock.fn(async () =>
      new Response(JSON.stringify({ id: 'test' }), { status: 200 })
    ) as any
    const result = await probeProviderKey('sk-test', 'https://api.example.com/v1')
    assert.equal(result.ok, true)
    assert.equal(result.status, 200)
    assert.equal(result.error, undefined)
  })

  it('normalizes trailing slash in baseUrl before appending /models', async () => {
    let capturedUrl = ''
    global.fetch = mock.fn(async (url: string) => {
      capturedUrl = url
      return new Response(JSON.stringify({}), { status: 200 })
    }) as any
    await probeProviderKey('sk-test', 'https://api.example.com/v1/')
    assert.match(capturedUrl, /https:\/\/api\.example\.com\/v1\/models/)
  })

  it('returns auth-failed for 401', async () => {
    global.fetch = mock.fn(async () =>
      new Response(JSON.stringify({}), { status: 401 })
    )
    const result = await probeProviderKey('sk-bad', 'https://api.example.com/v1')
    assert.equal(result.ok, false)
    assert.equal(result.status, 401)
    assert.equal(result.error, 'auth-failed')
  })

  it('returns auth-failed for 403', async () => {
    global.fetch = mock.fn(async () =>
      new Response(JSON.stringify({}), { status: 403 })
    )
    const result = await probeProviderKey('sk-bad', 'https://api.example.com/v1')
    assert.equal(result.ok, false)
    assert.equal(result.error, 'auth-failed')
  })

  it('returns http-N for other error statuses', async () => {
    global.fetch = mock.fn(async () =>
      new Response(JSON.stringify({}), { status: 500 })
    )
    const result = await probeProviderKey('sk-test', 'https://api.example.com/v1')
    assert.equal(result.ok, false)
    assert.equal(result.status, 500)
    assert.equal(result.error, 'http-500')
  })

  it('returns network-error on fetch exception', async () => {
    global.fetch = mock.fn(async () =>
      Promise.reject(new Error('ECONNREFUSED'))
    )
    const result = await probeProviderKey('sk-test', 'https://api.example.com/v1')
    assert.equal(result.ok, false)
    assert.equal(result.error, 'network-error')
  })

  it('returns timeout on timeout error', async () => {
    global.fetch = mock.fn(async () =>
      Promise.reject(new DOMException('timeout', 'AbortError'))
    )
    const result = await probeProviderKey('sk-test', 'https://api.example.com/v1')
    assert.equal(result.ok, false)
    assert.equal(result.error, 'timeout')
  })

  it('rejects empty apiKey', async () => {
    global.fetch = mock.fn(async () => new Response('', { status: 200 }))
    const result = await probeProviderKey('', 'https://api.example.com/v1')
    assert.equal(result.ok, false)
    assert.equal(result.error, 'API key is empty')
    assert.equal((global.fetch as any).mock.calls.length, 0)
  })

  it('rejects whitespace-only apiKey', async () => {
    global.fetch = mock.fn(async () => new Response('', { status: 200 }))
    const result = await probeProviderKey('   ', 'https://api.example.com/v1')
    assert.equal(result.ok, false)
    assert.equal(result.error, 'API key is empty')
  })

  it('strips multiple trailing slashes', async () => {
    let capturedUrl = ''
    global.fetch = mock.fn(async (url: string) => {
      capturedUrl = url
      return new Response(JSON.stringify({}), { status: 200 })
    }) as any
    await probeProviderKey('sk-test', 'https://api.example.com/v1///')
    assert.match(capturedUrl, /https:\/\/api\.example\.com\/v1\/models/)
  })

  it('sends Bearer Authorization header with trimmed key', async () => {
    let capturedHeaders: Record<string, string> = {}
    global.fetch = mock.fn(async (_url: string, init?: Record<string, unknown>) => {
      capturedHeaders = (init?.headers as Record<string, string>) ?? {}
      return new Response(JSON.stringify({}), { status: 200 })
    }) as any
    await probeProviderKey('  sk-trimmed  ', 'https://api.example.com/v1')
    assert.equal(capturedHeaders.Authorization, 'Bearer sk-trimmed')
  })
})
