import { describe, it, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { resolveProxyForUrl, shouldBypassProxy } from '../proxy-resolver.js'

describe('shouldBypassProxy', () => {
  it('returns false when NO_PROXY unset', () => {
    assert.equal(shouldBypassProxy('example.com', undefined), false)
  })

  it('bypasses all on *', () => {
    assert.equal(shouldBypassProxy('example.com', '*'), true)
  })

  it('matches exact domain (case-insensitive)', () => {
    assert.equal(shouldBypassProxy('api.deepseek.com', 'api.deepseek.com'), true)
    assert.equal(shouldBypassProxy('API.DEEPSEEK.COM', 'api.deepseek.com'), true)
  })

  it('matches .suffix for subdomains and bare domain', () => {
    assert.equal(shouldBypassProxy('docs.example.com', '.example.com'), true)
    assert.equal(shouldBypassProxy('example.com', '.example.com'), true)
  })

  it('does not match unrelated domain', () => {
    assert.equal(shouldBypassProxy('other.com', '.example.com'), false)
  })

  it('handles comma-separated list with whitespace', () => {
    assert.equal(shouldBypassProxy('a.com', 'a.com, b.com , c.com'), true)
    assert.equal(shouldBypassProxy('b.com', 'a.com, b.com , c.com'), true)
    assert.equal(shouldBypassProxy('d.com', 'a.com, b.com , c.com'), false)
  })
})

describe('resolveProxyForUrl', () => {
  const savedEnv: Record<string, string | undefined> = {}
  const envKeys = ['HTTPS_PROXY', 'https_proxy', 'HTTP_PROXY', 'http_proxy', 'NO_PROXY', 'no_proxy']

  beforeEach(() => {
    for (const k of envKeys) { savedEnv[k] = process.env[k]; delete process.env[k] }
  })
  afterEach(() => {
    for (const k of envKeys) {
      if (savedEnv[k] === undefined) delete process.env[k]
      else process.env[k] = savedEnv[k]
    }
  })

  it('returns undefined when no proxy configured', () => {
    assert.equal(resolveProxyForUrl('https://example.com'), undefined)
  })

  it('reads HTTPS_PROXY for https URLs', () => {
    process.env.HTTPS_PROXY = 'http://127.0.0.1:7890'
    assert.equal(resolveProxyForUrl('https://example.com'), 'http://127.0.0.1:7890')
  })

  it('reads HTTP_PROXY for http URLs', () => {
    process.env.HTTP_PROXY = 'http://127.0.0.1:7890'
    assert.equal(resolveProxyForUrl('http://example.com'), 'http://127.0.0.1:7890')
  })

  it('falls back HTTP_PROXY for https when HTTPS_PROXY absent', () => {
    process.env.HTTP_PROXY = 'http://127.0.0.1:7890'
    assert.equal(resolveProxyForUrl('https://example.com'), 'http://127.0.0.1:7890')
  })

  it('is case-insensitive on env var names', () => {
    process.env.https_proxy = 'http://127.0.0.1:7890'
    assert.equal(resolveProxyForUrl('https://example.com'), 'http://127.0.0.1:7890')
  })

  it('config proxyUrl takes precedence over env', () => {
    process.env.HTTPS_PROXY = 'http://env:7890'
    assert.equal(
      resolveProxyForUrl('https://example.com', { proxyUrl: 'http://config:1080' }),
      'http://config:1080',
    )
  })

  it('config noProxy bypasses even with proxy set', () => {
    process.env.HTTPS_PROXY = 'http://127.0.0.1:7890'
    assert.equal(
      resolveProxyForUrl('https://localhost:3000', { noProxy: 'localhost' }),
      undefined,
    )
  })

  it('env NO_PROXY bypasses', () => {
    process.env.HTTPS_PROXY = 'http://127.0.0.1:7890'
    process.env.NO_PROXY = '.internal.example.com'
    assert.equal(
      resolveProxyForUrl('https://api.internal.example.com'),
      undefined,
    )
  })

  it('returns undefined for invalid URL', () => {
    assert.equal(resolveProxyForUrl('not-a-url'), undefined)
  })

  it('returns undefined for non-http protocols', () => {
    assert.equal(resolveProxyForUrl('ftp://example.com'), undefined)
  })
})
