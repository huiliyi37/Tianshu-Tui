import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { createBatchConvergenceHook } from '../batch-convergence-hook.js'
import type { AdvisoryEntry } from '../../advisory-bus.js'
import type { RuntimeHookContext, RuntimeToolEvent } from '../../runtime-hooks.js'

function makeCtx(turn = 1): RuntimeHookContext {
  return {
    snapshot: { cwd: '/fake', turn, recentToolHistory: [], sensorium: null },
    effects: {},
  } as unknown as RuntimeHookContext
}

function tool(name: string): RuntimeToolEvent {
  return { name, success: true } as unknown as RuntimeToolEvent
}

function harness() {
  const submitted: AdvisoryEntry[] = []
  const hook = createBatchConvergenceHook({
    advisoryBus: { submit: (e: AdvisoryEntry) => { submitted.push(e) } },
  })
  return { submitted, hook }
}

describe('batch-convergence-hook', () => {
  it('<5 个工具不触发', async () => {
    const { submitted, hook } = harness()
    for (let i = 0; i < 4; i++) {
      await hook.run(makeCtx(), tool('grep'))
    }
    assert.equal(submitted.length, 0)
  })

  it('≥5 个工具触发收敛提醒', async () => {
    const { submitted, hook } = harness()
    for (let i = 0; i < 5; i++) {
      await hook.run(makeCtx(), tool('grep'))
    }
    assert.equal(submitted.length, 1)
    assert.equal(submitted[0]!.key, 'batch-convergence')
    assert.equal(submitted[0]!.category, 'discipline')
    assert.equal(submitted[0]!.tier, 'operational')
    assert.match(submitted[0]!.content, /三层收敛/)
    assert.match(submitted[0]!.content, /分桶/)
    assert.match(submitted[0]!.content, /交叉验证/)
  })

  it('同 turn 不重复触发', async () => {
    const { submitted, hook } = harness()
    for (let i = 0; i < 10; i++) {
      await hook.run(makeCtx(), tool('grep'))
    }
    assert.equal(submitted.length, 1)
  })

  it('turn 切换后计数器清零并重新触发', async () => {
    const { submitted, hook } = harness()
    // turn 1
    for (let i = 0; i < 5; i++) {
      await hook.run(makeCtx(1), tool('grep'))
    }
    assert.equal(submitted.length, 1)
    // turn 2 — 应重新计数并触发
    for (let i = 0; i < 5; i++) {
      await hook.run(makeCtx(2), tool('grep'))
    }
    assert.equal(submitted.length, 2)
  })

  it('turn 切换后 <5 不触发', async () => {
    const { submitted, hook } = harness()
    // turn 1: 触发
    for (let i = 0; i < 5; i++) {
      await hook.run(makeCtx(1), tool('grep'))
    }
    assert.equal(submitted.length, 1)
    // turn 2: 仅 3 个，不触发
    for (let i = 0; i < 3; i++) {
      await hook.run(makeCtx(2), tool('grep'))
    }
    assert.equal(submitted.length, 1)
  })

  it('advisory ttl=1 仅本轮有效', async () => {
    const { submitted, hook } = harness()
    for (let i = 0; i < 5; i++) {
      await hook.run(makeCtx(), tool('glob'))
    }
    assert.equal(submitted[0]!.ttl, 1)
  })
})
