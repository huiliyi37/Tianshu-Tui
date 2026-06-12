import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { renderTaskDepthAdvisory } from '../../prompt/volatile.js'
import { upgradeScaleByDepth } from '../../agent/review-discipline.js'
import { buildGateConvergenceHint } from '../../agent/delivery-gate-v2.js'

describe('renderTaskDepthAdvisory', () => {
  it('returns null for unit depth', () => {
    assert.equal(renderTaskDepthAdvisory('unit'), null)
  })

  it('returns null for undefined depth', () => {
    assert.equal(renderTaskDepthAdvisory(undefined), null)
  })

  it('returns wiring advisory with correct XML tag', () => {
    const result = renderTaskDepthAdvisory('wiring')
    assert.ok(result)
    assert.ok(result.includes('layer="wiring"'), 'should contain layer="wiring"')
    assert.ok(result.includes('mock'), 'should warn about mocks')
    assert.ok(result.includes('集成'), 'should mention integration testing (集成)')
  })

  it('returns system advisory with correct XML tag', () => {
    const result = renderTaskDepthAdvisory('system')
    assert.ok(result)
    assert.ok(result.includes('layer="system"'), 'should contain layer="system"')
    assert.ok(result.includes('端到端'), 'should mention end-to-end')
  })
})

describe('upgradeScaleByDepth', () => {
  it('does not upgrade for unit depth', () => {
    assert.equal(upgradeScaleByDepth('L1', 'unit'), 'L1')
    assert.equal(upgradeScaleByDepth('L2', 'unit'), 'L2')
  })

  it('does not upgrade for undefined depth', () => {
    assert.equal(upgradeScaleByDepth('L1', undefined), 'L1')
  })

  it('upgrades L1 → L2 for wiring', () => {
    assert.equal(upgradeScaleByDepth('L1', 'wiring'), 'L2')
  })

  it('keeps L2 for wiring (no downgrade needed)', () => {
    assert.equal(upgradeScaleByDepth('L2', 'wiring'), 'L2')
  })

  it('keeps L3 for wiring (already high enough)', () => {
    assert.equal(upgradeScaleByDepth('L3', 'wiring'), 'L3')
  })

  it('upgrades any level to L3 for system', () => {
    assert.equal(upgradeScaleByDepth('L1', 'system'), 'L3')
    assert.equal(upgradeScaleByDepth('L2', 'system'), 'L3')
    assert.equal(upgradeScaleByDepth('L3', 'system'), 'L3')
  })
})

describe('buildGateConvergenceHint with depthLayer', () => {
  it('GREEN + unit has no depth suffix', () => {
    const hint = buildGateConvergenceHint({ state: 'GREEN' }, 'unit')
    assert.ok(!hint.includes('[depth='), 'unit should not add depth annotation')
  })

  it('GREEN + wiring adds depth suffix', () => {
    const hint = buildGateConvergenceHint({ state: 'GREEN' }, 'wiring')
    assert.ok(hint.includes('[depth=wiring]'), 'wiring should add depth annotation')
    assert.ok(hint.includes('跨模块'), 'should mention cross-module verification')
  })

  it('RED + system adds depth suffix', () => {
    const hint = buildGateConvergenceHint(
      { state: 'RED', blockingReason: '未验证文件' },
      'system',
    )
    assert.ok(hint.includes('[depth=system]'), 'system should add depth annotation')
  })

  it('YELLOW + undefined has no depth suffix', () => {
    const hint = buildGateConvergenceHint({ state: 'YELLOW' })
    assert.ok(!hint.includes('[depth='), 'undefined should not add depth annotation')
  })
})
