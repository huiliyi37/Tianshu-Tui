import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { isPrivateIP, resolveAndAssertPublic, SSRFError } from '../ssrf.js'

describe('isPrivateIP', () => {
  it('detects loopback IPv4', () => {
    assert.equal(isPrivateIP('127.0.0.1'), true)
  })

  it('detects 10.x.x.x range', () => {
    assert.equal(isPrivateIP('10.0.0.1'), true)
  })

  it('detects 192.168.x.x range', () => {
    assert.equal(isPrivateIP('192.168.1.1'), true)
  })

  it('detects 172.16.x.x range', () => {
    assert.equal(isPrivateIP('172.16.0.1'), true)
  })

  it('detects link-local 169.254.x.x', () => {
    assert.equal(isPrivateIP('169.254.169.254'), true)
  })

  it('allows public IPs', () => {
    assert.equal(isPrivateIP('8.8.8.8'), false)
    assert.equal(isPrivateIP('1.1.1.1'), false)
  })

  it('detects IPv6 loopback', () => {
    assert.equal(isPrivateIP('::1'), true)
  })

  it('allows public IPv6', () => {
    assert.equal(isPrivateIP('2001:4860:4860::8888'), false)
  })
})

describe('resolveAndAssertPublic', () => {
  it('returns address for public hostname', async () => {
    const result = await resolveAndAssertPublic('example.com', async () => ({ address: '93.184.216.34' }))
    assert.equal(result.address, '93.184.216.34')
  })

  it('throws SSRFError for private address', async () => {
    await assert.rejects(
      async () => resolveAndAssertPublic('evil.local', async () => ({ address: '10.0.0.1' })),
      (err: unknown) => err instanceof SSRFError && err.hostname === 'evil.local' && err.address === '10.0.0.1',
    )
  })
})
