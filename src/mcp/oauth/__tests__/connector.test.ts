import { describe, it, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

const testDir = mkdtempSync(join(tmpdir(), 'mcp-oauth-test-'))
process.env.RIVET_HOME = testDir

import { loadMcpOAuthToken, revokeMcpOAuth, hasMcpOAuthToken } from '../connector.js'
import { findMcpOAuthProvider } from '../providers.js'
import { resolveOAuthEnv, resolveOAuthHeaders } from '../inject.js'
import { mcpServerConfigSchema } from '../../config.js'

afterEach(() => {
  try { rmSync(testDir, { recursive: true, force: true }) } catch { /* ignore */ }
})

describe('findMcpOAuthProvider', () => {
  it('finds github provider', () => {
    const p = findMcpOAuthProvider('github')
    assert.ok(p)
    assert.equal(p!.id, 'github')
    assert.ok(p!.authorizeUrl.includes('github.com'))
  })

  it('returns undefined for unknown provider', () => {
    assert.equal(findMcpOAuthProvider('nonexistent'), undefined)
  })
})

describe('resolveOAuthEnv', () => {
  const token = { accessToken: 'gh_token_abc', refreshToken: undefined, expiresAt: Date.now() + 3600_000, provider: 'github', scopes: ['repo'] }
  
  it('maps github token to GITHUB_PERSONAL_ACCESS_TOKEN', () => {
    const env = resolveOAuthEnv('github', token)
    assert.equal(env.GITHUB_PERSONAL_ACCESS_TOKEN, 'gh_token_abc')
  })

  it('maps linear token to LINEAR_API_KEY', () => {
    const env = resolveOAuthEnv('linear', { ...token, provider: 'linear' })
    assert.equal(env.LINEAR_API_KEY, 'gh_token_abc')
  })

  it('uses uppercase provider name for unknown provider', () => {
    const env = resolveOAuthEnv('unknown', token)
    assert.equal(env.UNKNOWN_API_KEY, 'gh_token_abc')
  })
})

describe('resolveOAuthHeaders', () => {
  it('returns Authorization Bearer', () => {
    const token = { accessToken: 'tok', refreshToken: undefined, expiresAt: Date.now() + 3600_000, provider: 'github', scopes: [] }
    const headers = resolveOAuthHeaders('github', token)
    assert.equal(headers.Authorization, 'Bearer tok')
  })
})

describe('mcpServerConfigSchema with auth', () => {
  it('accepts valid oauth config', () => {
    const result = mcpServerConfigSchema.safeParse({
      command: 'npx', args: ['-y', 'test'],
      auth: { type: 'oauth', provider: 'github', scopes: ['repo'] },
    })
    assert.ok(result.success)
  })

  it('rejects invalid auth type', () => {
    const result = mcpServerConfigSchema.safeParse({
      command: 'npx', args: ['-y', 'test'],
      auth: { type: 'invalid', provider: 'github' },
    })
    assert.ok(!result.success)
  })
})
