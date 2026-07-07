import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { AnchorVault } from '../anchor-vault.js'

describe('AnchorVault', () => {
  it('seal extracts key phrases from user message', () => {
    const vault = new AnchorVault()
    const sealed = vault.seal('帮我重构 auth 模块，要支持 OAuth2 和 SAML')
    assert.ok(sealed.phrases.length > 0)
    assert.ok(sealed.phrases.some(p => p.includes('auth') || p.includes('OAuth')))
  })

  it('seal extracts CJK terms', () => {
    const vault = new AnchorVault()
    const sealed = vault.seal('重构认证模块，支持单点登录')
    assert.ok(sealed.phrases.some(p => p.includes('重构') || p.includes('认证')))
  })

  it('strip removes anchor phrases from context string', () => {
    const vault = new AnchorVault()
    const sealed = vault.seal('重构 auth 模块支持 OAuth2')
    const ctx = '当前正在分析 auth 模块的 OAuth2 实现方案'
    const stripped = vault.strip(ctx, sealed)
    assert.ok(!stripped.includes('auth'))
    assert.ok(!stripped.includes('OAuth2'))
  })

  it('unseal restores original phrases', () => {
    const vault = new AnchorVault()
    const sealed = vault.seal('重构 auth 模块')
    const phrases = vault.unseal(sealed)
    assert.ok(phrases.some(p => p.includes('auth')))
  })

  it('seal deduplicates phrases', () => {
    const vault = new AnchorVault()
    const sealed = vault.seal('auth auth auth module module')
    const unique = new Set(sealed.phrases)
    assert.equal(sealed.phrases.length, unique.size)
  })
})
