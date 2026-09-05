/**
 * 自治档（YOLO）轮数硬上限的映射契约（polling-flood P2）。
 *
 * 背景：maxTurns ≤ 0 曾被解释为 Number.MAX_SAFE_INTEGER（实际无限），
 * 把失控 run 的逃逸面全压给收敛守卫。现在解释为 AUTONOMOUS_HARD_CAP_TURNS
 * 有限硬上限——守卫依然先行，触顶走统一耗尽路径（最终轮预警对自治档
 * 同样生效，见 turn-orchestrator 的 turn === effectiveLimit - 1 分支）。
 */
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { AUTONOMOUS_HARD_CAP_TURNS, resolveEffectiveTurnLimit } from '../turn-orchestrator.js'

describe('resolveEffectiveTurnLimit（自治档硬上限）', () => {
  it('maxTurns ≤ 0（YOLO/自治）→ 有限硬上限，不再无限', () => {
    assert.equal(resolveEffectiveTurnLimit(0), AUTONOMOUS_HARD_CAP_TURNS)
    assert.equal(resolveEffectiveTurnLimit(-1), AUTONOMOUS_HARD_CAP_TURNS)
    assert.notEqual(resolveEffectiveTurnLimit(0), Number.MAX_SAFE_INTEGER)
  })

  it('正数 maxTurns 原样透传（非自治档语义不变）', () => {
    assert.equal(resolveEffectiveTurnLimit(1), 1)
    assert.equal(resolveEffectiveTurnLimit(200), 200)
  })

  it('硬上限量级：远大于默认档 200，但不是天文数字', () => {
    assert.ok(AUTONOMOUS_HARD_CAP_TURNS >= 500, '自治任务正常用不到上限')
    assert.ok(AUTONOMOUS_HARD_CAP_TURNS <= 10_000, '失控 run 必须有限耗尽')
    assert.ok(Number.isSafeInteger(AUTONOMOUS_HARD_CAP_TURNS))
  })
})
