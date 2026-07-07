import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { createTurnBudgetHook } from '../turn-budget-hook.js'
import type { AdvisoryEntry } from '../../advisory-bus.js'
import type { RuntimeHookContext } from '../../runtime-hooks.js'

function makeCtx(): RuntimeHookContext {
  return {
    snapshot: { cwd: '/fake', turn: 1, recentToolHistory: [], sensorium: null },
    effects: {},
  } as unknown as RuntimeHookContext
}

function harness(maxTurns: number) {
  const submitted: AdvisoryEntry[] = []
  let runTurn = 0
  const hook = createTurnBudgetHook({
    advisoryBus: { submit: e => { submitted.push(e) } },
    getMaxTurns: () => maxTurns,
    getRunTurn: () => runTurn,
  })
  return { submitted, hook, setTurn(t: number) { runTurn = t } }
}

describe('turn-budget-hook 缺口 D', () => {
  it('剩余轮数进入阈值区触发(maxTurns=50 → 阈值 5)', () => {
    const h = harness(50)
    h.setTurn(44) // 剩 6 > 5
    h.hook.run(makeCtx())
    assert.equal(h.submitted.length, 0)
    h.setTurn(45) // 剩 5 ≤ 5
    h.hook.run(makeCtx())
    assert.equal(h.submitted.length, 1)
    assert.equal(h.submitted[0]!.key, 'turn-budget')
    assert.equal(h.submitted[0]!.tier, 'operational')
    assert.match(h.submitted[0]!.content, /还剩 5 轮/)
  })

  it('小 maxTurns 用下限 3(maxTurns=10 → 阈值 max(3, 1)=3)', () => {
    const h = harness(10)
    h.setTurn(6) // 剩 4 > 3
    h.hook.run(makeCtx())
    assert.equal(h.submitted.length, 0)
    h.setTurn(7) // 剩 3 ≤ 3
    h.hook.run(makeCtx())
    assert.equal(h.submitted.length, 1)
  })

  it('出生即带 verify_attempted expect 谓词(因果账本)', () => {
    const h = harness(10)
    h.setTurn(8)
    h.hook.run(makeCtx())
    const expect = h.submitted[0]!.expect
    assert.ok(expect)
    assert.equal(expect.kind, 'verify_attempted')
    if (expect.kind === 'verify_attempted') assert.equal(expect.withinTurns, 2)
  })

  it('每 run 只触发一次', () => {
    const h = harness(10)
    h.setTurn(7)
    h.hook.run(makeCtx())
    h.setTurn(8)
    h.hook.run(makeCtx())
    h.setTurn(9)
    h.hook.run(makeCtx())
    assert.equal(h.submitted.length, 1)
  })

  it('新 run(轮数回卷)重新武装', () => {
    const h = harness(10)
    h.setTurn(8)
    h.hook.run(makeCtx())
    assert.equal(h.submitted.length, 1)
    h.setTurn(2) // 新 run
    h.hook.run(makeCtx())
    assert.equal(h.submitted.length, 1) // 剩 8 > 3 不触发
    h.setTurn(7)
    h.hook.run(makeCtx())
    assert.equal(h.submitted.length, 2)
  })

  it('maxTurns ≤ 0 不触发(防御)', () => {
    const h = harness(0)
    h.setTurn(5)
    h.hook.run(makeCtx())
    assert.equal(h.submitted.length, 0)
  })
})
