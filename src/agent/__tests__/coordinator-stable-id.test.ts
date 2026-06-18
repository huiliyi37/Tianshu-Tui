import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { deriveStableWorkOrderId } from '../coordinator.js'

// 回归锚点：议事会(council:seat-*)与 team(team:*)一样，结果绑定依赖
// workOrderId 的稳定推导。若 stableId 只认 team:，council parentTurnId 会
// 回退成 wo_<uuid>，runCouncil 的 result.workOrderId === `council:seat-${seat}`
// 全失配 → 所有席位静默降级为空贡献（虚假绿灯，见 2026-06-19 审查）。
describe('deriveStableWorkOrderId', () => {
  it('team: parentTurnId 稳定化为末两段', () => {
    assert.equal(deriveStableWorkOrderId('team:planner-tianquan'), 'team:planner-tianquan')
    assert.equal(deriveStableWorkOrderId('x:team:T1'), 'team:T1')
  })

  it('council: parentTurnId 稳定化（议事会席位结果绑定依赖此）', () => {
    assert.equal(deriveStableWorkOrderId('council:seat-tianquan'), 'council:seat-tianquan')
    assert.equal(deriveStableWorkOrderId('council:seat-fu'), 'council:seat-fu')
  })

  it('普通 parentTurnId 返回 undefined（调用方回退 wo_<uuid>）', () => {
    assert.equal(deriveStableWorkOrderId('turn-42'), undefined)
    assert.equal(deriveStableWorkOrderId('review:loop'), undefined)
  })
})
