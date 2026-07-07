import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { generatePKCE, buildAuthorizeUrl } from '../oauth.js'

describe('generatePKCE', () => {
  it('returns verifier and challenge', async () => {
    const pkce = await generatePKCE()
    assert.ok(pkce.verifier.length > 0)
    assert.ok(pkce.challenge.length > 0)
    assert.notEqual(pkce.verifier, pkce.challenge)
  })

  it('verifier is URL-safe base64', async () => {
    const pkce = await generatePKCE()
    assert.ok(/^[A-Za-z0-9\-_=]+$/.test(pkce.verifier))
  })

  it('generates unique pairs on each call', async () => {
    const a = await generatePKCE()
    const b = await generatePKCE()
    assert.notEqual(a.verifier, b.verifier)
  })
})

describe('buildAuthorizeUrl', () => {
  it('builds URL with required params', () => {
    const url = buildAuthorizeUrl({
      clientId: 'test-client',
      codeChallenge: 'test-challenge',
      redirectUri: 'http://localhost:1455/auth/callback',
      state: 'test-state',
    })
    assert.ok(url.startsWith('https://auth.openai.com/oauth/authorize'))
    assert.ok(url.includes('client_id=test-client'))
    assert.ok(url.includes('code_challenge=test-challenge'))
    assert.ok(url.includes('code_challenge_method=S256'))
    assert.ok(url.includes('state=test-state'))
    assert.ok(url.includes('scope=openid'))
  })
})
