import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { createAsyncCopilotHook, parseCopilotResponse, COPILOT_GATE_MIN_DECIDED } from '../async-copilot-hook.js'
import type { AdvisoryEntry } from '../../advisory-bus.js'
import type { AdvisoryKeyStats } from '../../advisory-readback.js'
import type { RuntimeHookContext } from '../../runtime-hooks.js'

type HistEntry = { tool: string; status: 'success' | 'failed'; target?: string; errorClass?: string }

function ctxAt(turn: number, history: HistEntry[] = []): RuntimeHookContext {
  return {
    snapshot: {
      cwd: '/tmp', turn,
      recentToolHistory: history as never,
      sensorium: { momentum: 0.8, pressure: 0.2, confidence: 0.9, complexity: 0.5, freshness: 0.5, stability: 0.8 },
      strategy: null, vigor: null, gitChangeRate: 0, season: null,
    },
    effects: {
      setSensorium() {}, setStrategy() {}, setVigor() {}, setGitChangeRate() {},
      injectUserMessage() {}, requestThetaCheck() {}, emitPhaseChange() {},
      emitDecisionShift() {}, markClaimStale() {},
    },
  }
}

interface Harness {
  submitted: AdvisoryEntry[]
  llmCalls: string[]
  hook: ReturnType<typeof createAsyncCopilotHook>
  ownStats: AdvisoryKeyStats
  totals: { adopted: number; ignored: number }
  /** 等待后台 promise 链完成 */
  settle: () => Promise<void>
}

function makeHarness(over: {
  totals?: { adopted: number; ignored: number }
  response?: string | null
  ownStats?: Partial<AdvisoryKeyStats>
} = {}): Harness {
  const submitted: AdvisoryEntry[] = []
  const llmCalls: string[] = []
  const totals = over.totals ?? { adopted: 8, ignored: 4 } // 66% > 30%,decided 12 >= 10
  const ownStats: AdvisoryKeyStats = { delivered: 0, adopted: 0, ignored: 0, ignoredStreak: 0, shadowHeld: 0, shadowSatisfied: 0, ...over.ownStats }
  const response = over.response === undefined ? 'ADVICE: 先跑基线再归因\nEXPECT: verify_attempted' : over.response

  const hook = createAsyncCopilotHook({
    advisoryBus: { submit: e => submitted.push(e) },
    readback: {
      getTotals: () => totals,
      getStats: () => new Map([['copilot-advice', ownStats]]),
    },
    getContext: () => ({ objective: '修复缓存失效', starDomain: '瑶光' }),
    complete: async (_sys, user) => { llmCalls.push(user); return response },
    baseInterval: 8,
  })
  return {
    submitted, llmCalls, hook, ownStats, totals,
    settle: () => new Promise(r => setImmediate(r)),
  }
}

describe('parseCopilotResponse — 两行协议', () => {
  it('解析 ADVICE + verify_attempted', () => {
    const p = parseCopilotResponse('ADVICE: 先验证\nEXPECT: verify_attempted')!
    assert.equal(p.advice, '先验证')
    assert.equal(p.expect?.kind, 'verify_attempted')
  })

  it('解析 tool_appears:<tool>', () => {
    const p = parseCopilotResponse('ADVICE: 查 git 历史\nEXPECT: tool_appears:bash')!
    assert.deepEqual(p.expect, { kind: 'tool_appears', tools: ['bash'], withinTurns: 2 })
  })

  it('EXPECT none / 缺失 → 无谓词;无 ADVICE 或超长 → null', () => {
    assert.equal(parseCopilotResponse('ADVICE: x\nEXPECT: none')!.expect, undefined)
    assert.equal(parseCopilotResponse('ADVICE: x')!.expect, undefined)
    assert.equal(parseCopilotResponse('随便说点什么'), null)
    assert.equal(parseCopilotResponse(`ADVICE: ${'长'.repeat(401)}`), null)
  })
})

describe('async-copilot hook — 可行性闸门与触发', () => {
  it('采纳率闸门未过(decided 不足) → 不调 LLM', async () => {
    const h = makeHarness({ totals: { adopted: 2, ignored: 1 } }) // decided 3 < 10
    h.hook.run(ctxAt(20))
    await h.settle()
    assert.equal(h.llmCalls.length, 0)
  })

  it('采纳率闸门未过(rate < 30%) → 不调 LLM', async () => {
    const h = makeHarness({ totals: { adopted: 2, ignored: 10 } }) // 16% < 30%
    h.hook.run(ctxAt(20))
    await h.settle()
    assert.equal(h.llmCalls.length, 0)
    assert.ok(COPILOT_GATE_MIN_DECIDED <= 12)
  })

  it('闸门过 + 间隔到 → 合成并投递(星域 informational,带 expect)', async () => {
    const h = makeHarness()
    h.hook.run(ctxAt(10))
    await h.settle()
    assert.equal(h.llmCalls.length, 1)
    assert.ok(h.llmCalls[0]!.includes('修复缓存失效'), '情境包含任务目标')
    assert.ok(h.llmCalls[0]!.includes('瑶光'), '情境包含星域')
    assert.equal(h.submitted.length, 1)
    const e = h.submitted[0]!
    assert.equal(e.key, 'copilot-advice')
    assert.equal(e.category, 'star_domain')
    assert.equal(e.tier, 'informational')
    assert.ok(e.content.startsWith('【副驾】'))
    assert.equal(e.expect?.kind, 'verify_attempted')
  })

  it('间隔内不重复触发;inFlight 期间不叠发', async () => {
    const h = makeHarness()
    h.hook.run(ctxAt(10))
    h.hook.run(ctxAt(11)) // inFlight/间隔双重拦截
    await h.settle()
    h.hook.run(ctxAt(12)) // 间隔未到（10+8=18）
    await h.settle()
    assert.equal(h.llmCalls.length, 1)
    h.hook.run(ctxAt(18)) // 到期
    await h.settle()
    assert.equal(h.llmCalls.length, 2)
  })

  it('stall 信号(verifyFailStreak>=2 + momentum 低)提前触发', async () => {
    const h = makeHarness()
    const stallHistory: HistEntry[] = [
      { tool: 'run_tests', status: 'failed' },
      { tool: 'run_tests', status: 'failed' },
    ]
    const ctx = ctxAt(3, stallHistory)
    ;(ctx.snapshot.sensorium as { momentum: number }).momentum = 0.2
    h.hook.run(ctx)
    await h.settle()
    assert.equal(h.llmCalls.length, 1, 'stall 触发不等常规间隔')
  })

  it('解析失败 → 不投递(不猜格式)', async () => {
    const h = makeHarness({ response: '我觉得你应该冷静一下' })
    h.hook.run(ctxAt(10))
    await h.settle()
    assert.equal(h.submitted.length, 0)
  })

  it('complete 返回 null(基础设施缺失) → 永久休眠', async () => {
    const h = makeHarness({ response: null })
    h.hook.run(ctxAt(10))
    await h.settle()
    h.hook.run(ctxAt(30))
    await h.settle()
    assert.equal(h.llmCalls.length, 1, '第一次探测后不再调用')
    assert.equal(h.submitted.length, 0)
  })
})

describe('async-copilot hook — 自我淘汰降频', () => {
  it('自身采纳率低(decided>=4 且 <25%) → 间隔翻倍', async () => {
    const h = makeHarness({ ownStats: { delivered: 5, adopted: 0, ignored: 5, ignoredStreak: 5 } })
    assert.equal(h.hook.getInterval(), 8)
    h.hook.run(ctxAt(10))
    await h.settle()
    assert.equal(h.hook.getInterval(), 16, '投递后按账本降频')
  })

  it('自身采纳率恢复(>=50%) → 间隔向 base 回落', async () => {
    const h = makeHarness({ ownStats: { delivered: 8, adopted: 0, ignored: 8, ignoredStreak: 8 } })
    h.hook.run(ctxAt(10))
    await h.settle()
    assert.equal(h.hook.getInterval(), 16)
    // 账本改善
    h.ownStats.adopted = 8
    h.ownStats.ignored = 4
    h.hook.run(ctxAt(30))
    await h.settle()
    assert.equal(h.hook.getInterval(), 8, '采纳率恢复后提频')
  })
})
