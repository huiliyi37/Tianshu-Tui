import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { matchDomain, STAR_DOMAINS, buildActiveDomain } from '../star-domain.js'

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

  it('pojun toolWhitelist includes write_file (explorer can modify)', () => {
    assert.ok(STAR_DOMAINS.pojun.toolWhitelist.includes('write_file'))
    assert.ok(STAR_DOMAINS.pojun.toolWhitelist.includes('edit_file'))
    assert.ok(STAR_DOMAINS.pojun.toolWhitelist.includes('bash'))
  })

  it('tianfu toolWhitelist is read-only (guardian cannot modify)', () => {
    assert.ok(STAR_DOMAINS.tianfu.toolWhitelist.includes('read_file'))
    assert.ok(!STAR_DOMAINS.tianfu.toolWhitelist.includes('write_file'))
    assert.ok(!STAR_DOMAINS.tianfu.toolWhitelist.includes('edit_file'))
    assert.ok(!STAR_DOMAINS.tianfu.toolWhitelist.includes('bash'))
  })

  it('tianliang toolWhitelist includes write_file + run_tests (executor delivers)', () => {
    assert.ok(STAR_DOMAINS.tianliang.toolWhitelist.includes('write_file'))
    assert.ok(STAR_DOMAINS.tianliang.toolWhitelist.includes('run_tests'))
  })

  it('all domains have systemPromptSuffix', () => {
    for (const domain of Object.values(STAR_DOMAINS)) {
      assert.ok(domain.systemPromptSuffix.length > 0, `${domain.name} missing suffix`)
    }
  })

  it('matchDomain result has toolWhitelist accessible via STAR_DOMAINS', () => {
    const id = matchDomain('探索新功能')
    assert.ok(id)
    const domain = STAR_DOMAINS[id]
    assert.ok(domain.toolWhitelist.length > 0)
    assert.ok(domain.systemPromptSuffix.length > 0)
  })
})

describe('buildActiveDomain', () => {
  it('returns domain info for matched task', () => {
    const result = buildActiveDomain('探索新的认证方案')
    assert.ok(result)
    assert.equal(result.name, '破军')
    assert.ok(result.volatileBlock.includes('破军'))
    assert.ok(result.motto)
  })

  it('returns null for ambiguous task', () => {
    assert.equal(buildActiveDomain('帮我看看'), null)
  })
})
