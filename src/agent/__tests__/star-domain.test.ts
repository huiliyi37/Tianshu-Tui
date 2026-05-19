import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { matchDomain, STAR_DOMAINS } from '../star-domain.js'

describe('StarDomain', () => {
  it('exports three built-in domains', () => {
    const domains = Object.values(STAR_DOMAINS)
    assert.equal(domains.length, 3)
    for (const domain of domains) {
      assert.ok(domain.id)
      assert.ok(domain.name)
      assert.ok(domain.motto)
      assert.ok(domain.volatileBlock)
      assert.equal(domain.isCustom, false)
      assert.ok(typeof domain.courageThreshold === 'number')
    }
  })

  it('routes exploration keywords to pojun', () => {
    assert.equal(matchDomain('探索一个新的缓存方案'), 'pojun')
    assert.equal(matchDomain('实验性地尝试 WebSocket'), 'pojun')
  })

  it('routes stability keywords to tianfu', () => {
    assert.equal(matchDomain('重构 session 管理模块'), 'tianfu')
    assert.equal(matchDomain('修复内存泄漏'), 'tianfu')
  })

  it('routes delivery keywords to tianliang', () => {
    assert.equal(matchDomain('按计划实现用户注册'), 'tianliang')
    assert.equal(matchDomain('编写单元测试覆盖'), 'tianliang')
  })

  it('returns null for ambiguous tasks', () => {
    assert.equal(matchDomain('帮我看看'), null)
    assert.equal(matchDomain('探索并修复缓存问题'), null)
  })
})
