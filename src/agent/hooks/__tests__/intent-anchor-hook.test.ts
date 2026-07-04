import { describe, it, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { createIntentAnchorHook } from '../intent-anchor-hook.js'
import type { AdvisoryEntry } from '../../advisory-bus.js'
import type { RuntimeHookContext } from '../../runtime-hooks.js'

function makeCtx(): RuntimeHookContext {
  return {
    snapshot: { cwd: '/fake', turn: 1, recentToolHistory: [], sensorium: null },
    effects: {},
  } as unknown as RuntimeHookContext
}

function harness(over?: { objective?: string | null }) {
  const submitted: AdvisoryEntry[] = []
  let runTurn = 0
  let lastUserInputTurn = 0
  const hook = createIntentAnchorHook({
    advisoryBus: { submit: e => { submitted.push(e) } },
    getRunTurn: () => runTurn,
    getLastUserInputTurn: () => lastUserInputTurn,
    getObjective: () => over?.objective === undefined ? '修复 read_file 缓存 bug' : over.objective,
  })
  return {
    submitted, hook,
    setTurn(t: number) { runTurn = t },
    setLastInput(t: number) { lastUserInputTurn = t },
  }
}

afterEach(() => {
  delete process.env.RIVET_INTENT_ANCHOR_TURNS
  delete process.env.RIVET_INTENT_ANCHOR_STALE
})

describe('intent-anchor-hook 缺口 C', () => {
  it('run 轮数超阈值且用户输入陈旧时触发,内容含意图', () => {
    const h = harness()
    h.setTurn(21)
    h.hook.run(makeCtx())
    assert.equal(h.submitted.length, 1)
    assert.equal(h.submitted[0]!.key, 'intent-anchor')
    assert.equal(h.submitted[0]!.tier, 'informational')
    assert.match(h.submitted[0]!.content, /修复 read_file 缓存 bug/)
    assert.equal(h.submitted[0]!.expect, undefined) // 无行为签名,只计送达
  })

  it('轮数不足不触发', () => {
    const h = harness()
    h.setTurn(20)
    h.hook.run(makeCtx())
    assert.equal(h.submitted.length, 0)
  })

  it('距上次用户输入 ≤10 轮不触发(steer 注入重置 stale)', () => {
    const h = harness()
    h.setTurn(25)
    h.setLastInput(18) // 25-18=7 ≤ 10
    h.hook.run(makeCtx())
    assert.equal(h.submitted.length, 0)
  })

  it('触发后冷却 10 轮', () => {
    const h = harness()
    h.setTurn(21)
    h.hook.run(makeCtx())
    h.setTurn(25)
    h.hook.run(makeCtx())
    assert.equal(h.submitted.length, 1) // 冷却中
    h.setTurn(31)
    h.hook.run(makeCtx())
    assert.equal(h.submitted.length, 2) // 冷却结束
  })

  it('新 run(轮数回卷)冷却清零', () => {
    const h = harness()
    h.setTurn(21)
    h.hook.run(makeCtx())
    assert.equal(h.submitted.length, 1)
    // 新 run 从 0 重计,推进到 21
    h.setTurn(21)
    h.hook.run(makeCtx())
    assert.equal(h.submitted.length, 1) // 21 == lastFired 21? 回卷未发生
    h.setTurn(5)
    h.hook.run(makeCtx()) // 回卷信号
    h.setTurn(21)
    h.hook.run(makeCtx())
    assert.equal(h.submitted.length, 2)
  })

  it('意图源为空不触发', () => {
    const h = harness({ objective: null })
    h.setTurn(30)
    h.hook.run(makeCtx())
    assert.equal(h.submitted.length, 0)
  })

  it('阈值可用 env 覆盖', () => {
    process.env.RIVET_INTENT_ANCHOR_TURNS = '5'
    const h = harness()
    h.setTurn(6)
    h.hook.run(makeCtx())
    assert.equal(h.submitted.length, 0) // stale 条件仍不满足? 6-0=6 ≤ 10
    process.env.RIVET_INTENT_ANCHOR_STALE = '3'
    h.setTurn(7)
    h.hook.run(makeCtx())
    assert.equal(h.submitted.length, 1)
  })

  it('超长意图截断到 500 字', () => {
    const h = harness({ objective: 'x'.repeat(800) })
    h.setTurn(21)
    h.hook.run(makeCtx())
    assert.equal(h.submitted.length, 1)
    const quoted = h.submitted[0]!.content.match(/「(x+)」/)
    assert.ok(quoted)
    assert.equal(quoted![1]!.length, 500)
  })
})
