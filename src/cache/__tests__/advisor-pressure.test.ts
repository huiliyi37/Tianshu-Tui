/**
 * Track 4: shouldDelayCompact 显式权衡 — cache miss 成本 vs 压缩收益。
 *
 * 契约（protection = hitRate × (1 − pressure)，阈值 0.45）：
 * - 热缓存 + 低压力 → 延迟压缩（保护前缀）
 * - 热缓存 + 高压力 → 放行压缩（1M 余量 > 重建成本）
 * - tier ≥ 3 永不延迟
 * - 无压力上下文 → 旧行为不变（hitRate ≥ 0.8 延迟）
 */

import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { CacheAdvisor } from '../advisor.js'

function advisorWithHitRate(hitRate: number): CacheAdvisor {
  const advisor = new CacheAdvisor({ providerProfile: { cacheType: 'exact-prefix', persistent: true } })
  // One observed turn with the desired hit rate
  const total = 1000
  advisor.onTurnEnd({
    turn: 1,
    cacheRead: Math.round(total * hitRate),
    cacheCreation: total - Math.round(total * hitRate),
    prefixChanged: false,
    artifactIdsEvicted: [],
    artifactIdsAccessed: [],
  })
  return advisor
}

describe('shouldDelayCompact pressure tradeoff (Track 4)', () => {
  it('hot cache + low pressure delays compaction', () => {
    const advisor = advisorWithHitRate(0.9)
    assert.equal(
      advisor.shouldDelayCompact(2, { estimatedTokens: 300_000, contextWindow: 1_000_000 }),
      true,
      'protection 0.9×0.7=0.63 ≥ 0.45 → delay',
    )
  })

  it('hot cache + high pressure lets compaction through', () => {
    const advisor = advisorWithHitRate(0.9)
    assert.equal(
      advisor.shouldDelayCompact(2, { estimatedTokens: 600_000, contextWindow: 1_000_000 }),
      false,
      'protection 0.9×0.4=0.36 < 0.45 → compact',
    )
  })

  it('cold cache never delays even at low pressure', () => {
    const advisor = advisorWithHitRate(0.2)
    assert.equal(
      advisor.shouldDelayCompact(2, { estimatedTokens: 100_000, contextWindow: 1_000_000 }),
      false,
    )
  })

  it('tier 3+ never delays regardless of cache health', () => {
    const advisor = advisorWithHitRate(0.95)
    assert.equal(advisor.shouldDelayCompact(3, { estimatedTokens: 100_000, contextWindow: 1_000_000 }), false)
    assert.equal(advisor.shouldDelayCompact(4), false)
  })

  it('no pressure context falls back to legacy hit-rate rule', () => {
    assert.equal(advisorWithHitRate(0.85).shouldDelayCompact(2), true)
    assert.equal(advisorWithHitRate(0.5).shouldDelayCompact(2), false)
  })
})
