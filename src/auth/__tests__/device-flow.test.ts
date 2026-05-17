import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { buildDeviceCodeRequest, parseDeviceCodeResponse, parseTokenResponse } from '../device-flow.js'

describe('buildDeviceCodeRequest', () => {
  it('builds correct request body', () => {
    const body = buildDeviceCodeRequest('test-client')
    assert.equal(body.client_id, 'test-client')
    assert.ok(body.scope?.includes('openid'))
  })
})

describe('parseDeviceCodeResponse', () => {
  it('parses valid response', () => {
    const result = parseDeviceCodeResponse({
      device_code: 'dc-123',
      user_code: 'ABCD-EFGH',
      verification_uri: 'https://auth.openai.com/codex/device',
      expires_in: 600,
      interval: 5,
    })
    assert.equal(result.deviceCode, 'dc-123')
    assert.equal(result.userCode, 'ABCD-EFGH')
    assert.equal(result.interval, 5)
  })

  it('throws on missing fields', () => {
    assert.throws(
      () => parseDeviceCodeResponse({}),
      /missing required fields/,
    )
  })
})

describe('parseTokenResponse', () => {
  it('parses successful token response', () => {
    const result = parseTokenResponse({
      access_token: 'at-123',
      refresh_token: 'rt-456',
      expires_in: 3600,
    })
    assert.equal(result.accessToken, 'at-123')
    assert.equal(result.refreshToken, 'rt-456')
    assert.ok(result.expiresAt > Date.now())
  })

  it('throws on error response', () => {
    assert.throws(
      () => parseTokenResponse({ error: 'authorization_pending' }),
      /authorization_pending/,
    )
  })

  it('defaults expires_in to 3600 when missing', () => {
    const result = parseTokenResponse({
      access_token: 'at',
    })
    assert.ok(result.expiresAt > Date.now())
    assert.ok(result.expiresAt <= Date.now() + 3600_000 + 1000)
  })
})
