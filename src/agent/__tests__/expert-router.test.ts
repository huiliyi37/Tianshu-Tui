import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  rankDomains,
  selectExpertSet,
  mergeRoleFor,
  MAX_COUNCIL_EXPERTS,
} from '../expert-router.js'

describe('expert-router — rankDomains', () => {
  it('returns all domains that scored, descending by score', () => {
    const ranked = rankDomains('审查这个方案的架构与取舍')
    assert.ok(ranked.length >= 1)
    // tianquan owns 审查/方案/架构/取舍 → should rank high
    assert.equal(ranked[0]!.id, 'tianquan')
    // scores are non-increasing
    for (let i = 1; i < ranked.length; i++) {
      assert.ok(ranked[i - 1]!.score >= ranked[i]!.score)
    }
  })

  it('returns empty for a task with no keyword hits', () => {
    assert.deepEqual(rankDomains('zzz qqq xxx'), [])
  })

  it('attaches merge role to each ranked domain', () => {
    const ranked = rankDomains('设计前端界面')
    const wenqu = ranked.find(d => d.id === 'wenqu')
    assert.ok(wenqu)
    assert.equal(wenqu.role, 'specialist')
  })
})

describe('expert-router — mergeRoleFor', () => {
  it('maps built-in domains to roles', () => {
    assert.equal(mergeRoleFor('tianquan'), 'base')
    assert.equal(mergeRoleFor('tianfu'), 'constraint')
    assert.equal(mergeRoleFor('tianxuan'), 'challenger')
    assert.equal(mergeRoleFor('wenqu'), 'specialist')
  })

  it('defaults unknown domains to specialist', () => {
    assert.equal(mergeRoleFor('some_user_domain'), 'specialist')
  })
})

describe('expert-router — selectExpertSet', () => {
  it('defaults to the historical trio (base+constraint+challenger) for generic tasks', () => {
    const set = selectExpertSet('帮我看看')
    assert.deepEqual(set, ['tianquan', 'tianfu', 'tianxuan'])
  })

  it('always places a base first', () => {
    const set = selectExpertSet('设计一个全新的前端组件库的视觉样式')
    assert.equal(mergeRoleFor(set[0]!), 'base')
  })

  it('pulls in a matched specialist (wenqu) for design tasks', () => {
    const set = selectExpertSet('设计前端界面的配色与布局', { maxExperts: 4 })
    assert.ok(set.includes('wenqu'))
    // base still present and first
    assert.equal(mergeRoleFor(set[0]!), 'base')
  })

  it('respects the maxExperts budget (clamped to [1, MAX])', () => {
    assert.equal(selectExpertSet('审查方案', { maxExperts: 1 }).length, 1)
    assert.equal(selectExpertSet('审查方案', { maxExperts: 1 })[0], 'tianquan')
    assert.ok(selectExpertSet('审查方案 设计 重构 质疑 探索', { maxExperts: 99 }).length <= MAX_COUNCIL_EXPERTS)
  })

  it('returns a diverse role set, not duplicates', () => {
    const set = selectExpertSet('重构并审查并质疑这个设计', { maxExperts: 5 })
    assert.equal(new Set(set).size, set.length, 'no duplicate experts')
    assert.ok(set.length >= 3)
  })

  it('never returns empty', () => {
    assert.ok(selectExpertSet('').length >= 1)
    assert.ok(selectExpertSet('zzz').length >= 1)
  })
})
