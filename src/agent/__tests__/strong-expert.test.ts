import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  STRONG_EXPERTS,
  __resetExpertBenchForTest,
  assertStrongExpertDispatchable,
  detectCriticalMoments,
  getExpertBenchStats,
  recordExpertBench,
  resolveStrongExpert,
} from '../strong-expert.js'

describe('strong expert manifest（P2a）', () => {
  it('首批 5 席定义完整且 modelPolicy 不出现 strong', () => {
    assert.deepEqual(Object.keys(STRONG_EXPERTS).sort(), ['adversarial', 'architecture', 'design', 'root_cause', 'surgeon'])
    for (const sea of Object.values(STRONG_EXPERTS)) {
      assert.ok(sea.baseProfile, `${sea.id} baseProfile 必填`)
      assert.ok(sea.authority, `${sea.id} authority 必填`)
      assert.ok(Array.isArray(sea.toolGrants), `${sea.id} toolGrants 必须为数组`)
      assert.ok(
        sea.modelPolicy.tierFloor === undefined || sea.modelPolicy.tierFloor === 'cheap' || sea.modelPolicy.tierFloor === 'balanced',
        `${sea.id} 禁止以模型档位替代专家带宽`,
      )
    }
  })

  it('只读诊断席 auto 允许；写席 surgeon 永不 auto', () => {
    for (const sea of Object.values(STRONG_EXPERTS)) {
      if (sea.write) assert.equal(sea.autoDispatch, false, '写席必须显式批准')
    }
    assert.equal(STRONG_EXPERTS.root_cause.autoDispatch, true)
    assert.equal(STRONG_EXPERTS.architecture.autoDispatch, true)
    assert.equal(STRONG_EXPERTS.adversarial.autoDispatch, true)
  })

  it('resolveStrongExpert：已知 id 返回 manifest，未知 fail-closed', () => {
    assert.equal(resolveStrongExpert('root_cause')?.id, 'root_cause')
    assert.equal(resolveStrongExpert('not-exist'), null)
  })

  it('surgeon 首批 fail-closed，显式开启才放行', () => {
    assert.throws(() => assertStrongExpertDispatchable(STRONG_EXPERTS.surgeon, false), /首批未开放/)
    assert.doesNotThrow(() => assertStrongExpertDispatchable(STRONG_EXPERTS.surgeon, true))
    assert.doesNotThrow(() => assertStrongExpertDispatchable(STRONG_EXPERTS.root_cause, false))
  })
})

describe('expert bench stats（P2d）', () => {
  it('按 session 分桶累计 summons/resumeHits/passed', () => {
    __resetExpertBenchForTest()
    recordExpertBench('s1', 'root_cause', { resumeHit: false, passed: 1, total: 1 })
    recordExpertBench('s1', 'root_cause', { resumeHit: true, passed: 1, total: 1 })
    recordExpertBench('s2', 'architecture', { resumeHit: false, passed: 0, total: 1 })

    const s1 = getExpertBenchStats('s1')
    assert.equal(s1.length, 1)
    assert.equal(s1[0]!.summons, 2)
    assert.equal(s1[0]!.resumeHits, 1)
    assert.equal(s1[0]!.passed, 2)
    assert.equal(s1[0]!.total, 2)
    assert.equal(getExpertBenchStats('s2')[0]!.expert, 'architecture')
    assert.deepEqual(getExpertBenchStats('none'), [])
    __resetExpertBenchForTest()
  })
})

describe('detectCriticalMoments（P2b）', () => {
  const empty = {
    doomLoopLevel: 'none' as const,
    repeatedToolFailures: 0,
    contextPressureRatio: 0,
  }

  it('无信号 → 空', () => {
    assert.deepEqual(detectCriticalMoments(empty), [])
  })

  it('doom-loop blocked → root_cause，且只读席 auto', () => {
    const moments = detectCriticalMoments({ ...empty, doomLoopLevel: 'blocked' })
    assert.equal(moments.length, 1)
    assert.equal(moments[0]!.kind, 'repeated-failure')
    assert.equal(moments[0]!.suggestedExpert, 'root_cause')
    assert.equal(moments[0]!.auto, true)
  })

  it('同工具失败重复 ≥3 → repeated-failure；<3 不触发', () => {
    assert.ok(detectCriticalMoments({ ...empty, repeatedToolFailures: 3 }).some(m => m.kind === 'repeated-failure'))
    assert.deepEqual(detectCriticalMoments({ ...empty, repeatedToolFailures: 2 }), [])
  })

  it('typecheck broken / wave gate failed / review rejected 映射正确', () => {
    assert.equal(detectCriticalMoments({ ...empty, typecheckBroken: true })[0]?.suggestedExpert, 'root_cause')
    assert.equal(detectCriticalMoments({ ...empty, waveGateFailed: true })[0]?.suggestedExpert, 'root_cause')
    assert.equal(detectCriticalMoments({ ...empty, reviewRejected: true })[0]?.suggestedExpert, 'adversarial')
  })

  it('scope leak / 跨模块爆炸半径 → architecture', () => {
    assert.equal(detectCriticalMoments({ ...empty, scopeLeakedFiles: ['src/a.ts'] })[0]?.suggestedExpert, 'architecture')
    assert.equal(detectCriticalMoments({ ...empty, crossModuleBlast: ['src/a.ts', 'src/b.ts'] })[0]?.suggestedExpert, 'architecture')
  })

  it('上下文压力 ≥0.7 → root_cause；低于阈值不触发', () => {
    assert.equal(detectCriticalMoments({ ...empty, contextPressureRatio: 0.7 })[0]?.suggestedExpert, 'root_cause')
    assert.deepEqual(detectCriticalMoments({ ...empty, contextPressureRatio: 0.69 }), [])
  })

  it('多信号按 kind 去重且顺序稳定', () => {
    const moments = detectCriticalMoments({
      ...empty,
      doomLoopLevel: 'blocked',
      repeatedToolFailures: 5,
      typecheckBroken: true,
    })
    assert.deepEqual(moments.map(m => m.kind), ['repeated-failure', 'verification-broken'])
  })
})
