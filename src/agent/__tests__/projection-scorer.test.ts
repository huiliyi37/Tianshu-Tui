import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { ProjectionScorer } from '../projection-scorer.js'

describe('ProjectionScorer', () => {
  it('returns low score when output is independent of anchor', () => {
    const scorer = new ProjectionScorer()
    const anchor = ['auth', 'OAuth2', '重构']
    const output = '文件系统使用 inode 管理元数据，ext4 支持日志'
    const score = scorer.score(output, anchor)
    assert.ok(score < 0.1, `expected < 0.1, got ${score}`)
  })

  it('returns high score when output is dominated by anchor terms', () => {
    const scorer = new ProjectionScorer()
    // Use terms NOT in HIGH_FREQ_VERBS so they aren't filtered
    const anchor = ['auth', 'OAuth2', 'token']
    const output = 'auth OAuth2 token auth refresh OAuth2 auth token validation auth OAuth2'
    const score = scorer.score(output, anchor)
    assert.ok(score > 0.3, `expected > 0.3, got ${score}`)
  })

  it('returns 0 for empty input', () => {
    const scorer = new ProjectionScorer()
    assert.equal(scorer.score('', ['auth']), 0)
    assert.equal(scorer.score('hello', []), 0)
  })

  it('deletionTest returns true when plan collapses without anchor', () => {
    const scorer = new ProjectionScorer()
    const anchor = ['auth', 'OAuth2', 'token']
    const plan = 'auth OAuth2 token auth refresh OAuth2 auth token validation auth OAuth2'
    assert.ok(scorer.deletionTest(plan, anchor))
  })

  it('deletionTest returns false when plan is self-coherent', () => {
    const scorer = new ProjectionScorer()
    const anchor = ['auth', 'OAuth2']
    const plan = 'Step 1: 定义接口契约和错误码\nStep 2: 实现 token 刷新机制\nStep 3: 集成测试覆盖全部分支'
    assert.ok(!scorer.deletionTest(plan, anchor))
  })
})
