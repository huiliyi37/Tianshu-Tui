import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  HANDS_GATE_REPAIR_RESERVE,
  MAX_BUDGET_CONTINUATIONS,
  MAX_HANDS_EXTRA_RUNS,
  buildContinuationObjective,
  decideContinuation,
  decideHandsContinuation,
  markContinued,
  mergeUsage,
  type ContinuationInput,
  type HandsContinuationInput,
} from '../worker-continuation.js'
import type { WorkerResult } from '../work-order.js'

function result(over: Partial<WorkerResult> = {}): WorkerResult {
  return {
    workOrderId: 'wo_1',
    status: 'blocked',
    summary: 'cut off mid-work',
    findings: [],
    artifacts: [],
    changedFiles: [],
    risks: [],
    nextActions: [],
    evidenceStatus: 'unverified',
    failureReason: 'max_turns',
    ...over,
  }
}

function input(over: Partial<ContinuationInput> = {}): ContinuationInput {
  return {
    result: result(),
    attempt: 0,
    aborted: false,
    isWrite: false,
    sharedWorktree: false,
    hasSessionMessages: true,
    ...over,
  }
}

describe('decideContinuation', () => {
  it('续跑预算耗尽的只读工', () => {
    for (const reason of ['max_turns', 'timeout'] as const) {
      const decision = decideContinuation(input({ result: result({ failureReason: reason }) }))
      assert.equal(decision.proceed, true, `${reason} 应触发续跑`)
      if (decision.proceed) assert.equal(decision.reason, reason)
    }
  })

  it('只有预算耗尽才续——其余失败原因换个跑法也是同样结果', () => {
    const others = [
      'caller_aborted', 'circuit_open', 'claim_conflict', 'json_parse',
      'schema_mismatch', 'worker_crash', 'worker_blocked', 'unknown',
    ] as const
    for (const reason of others) {
      const decision = decideContinuation(input({ result: result({ failureReason: reason }) }))
      assert.equal(decision.proceed, false, `${reason} 不该续跑`)
    }
    assert.equal(decideContinuation(input({ result: result({ failureReason: undefined }) })).proceed, false)
  })

  it('调用方已中止时不续——用户按了停就是停', () => {
    assert.equal(decideContinuation(input({ aborted: true })).proceed, false)
  })

  it('续跑次数有上限', () => {
    for (let attempt = 0; attempt < MAX_BUDGET_CONTINUATIONS; attempt++) {
      assert.equal(decideContinuation(input({ attempt })).proceed, true, `第 ${attempt} 次应放行`)
    }
    assert.equal(decideContinuation(input({ attempt: MAX_BUDGET_CONTINUATIONS })).proceed, false)
    assert.equal(decideContinuation(input({ attempt: MAX_BUDGET_CONTINUATIONS + 5 })).proceed, false)
  })

  it('没有会话消息就不续——那等于从零重来', () => {
    assert.equal(decideContinuation(input({ hasSessionMessages: false })).proceed, false)
  })

  it('写工在 coordinator 层一律不续——交由 hands-session 在工作树内处理', () => {
    const isolated = decideContinuation(input({ isWrite: true, sharedWorktree: false }))
    const shared = decideContinuation(input({ isWrite: true, sharedWorktree: true }))
    assert.equal(isolated.proceed, false)
    assert.equal(shared.proceed, false)
    if (!isolated.proceed && !shared.proceed) {
      assert.match(isolated.skipReason, /hands-session/)
      assert.match(shared.skipReason, /hands-session/)
      assert.match(isolated.skipReason, /隔离 worktree/)
      assert.match(shared.skipReason, /共享 worktree/)
    }
  })

  it('墙钟超时 + 产出停滞（工具调用 ≤ 3）→ 不续，skipReason 说明停滞', () => {
    for (const toolCalls of [0, 1, 2, 3]) {
      const decision = decideContinuation(input({ result: result({ failureReason: 'timeout' }), productivity: { toolCalls } }))
      assert.equal(decision.proceed, false, `toolCalls=${toolCalls} 停滞应拦截`)
      if (!decision.proceed) {
        assert.match(decision.skipReason, /停滞/, `skipReason 应含「停滞」：${decision.skipReason}`)
        assert.match(decision.skipReason, /工具调用/)
      }
    }
  })

  it('墙钟超时 + 产出正常（工具调用 > 3）→ 照常续跑，活跃慢通道不受影响', () => {
    for (const toolCalls of [4, 31, 47]) {
      const decision = decideContinuation(input({ result: result({ failureReason: 'timeout' }), productivity: { toolCalls } }))
      assert.equal(decision.proceed, true, `toolCalls=${toolCalls} 活跃轮应放行`)
    }
  })

  it('轮次撞顶（max_turns）调用少 → 不判停滞（轮次本就少是正常形态，非墙钟空转）', () => {
    for (const toolCalls of [0, 1, 2, 3]) {
      const decision = decideContinuation(input({ result: result({ failureReason: 'max_turns' }), productivity: { toolCalls } }))
      assert.equal(decision.proceed, true, `max_turns toolCalls=${toolCalls} 不应被停滞判据拦截`)
    }
  })

  it('未提供 productivity 度量 → 维持原判据（向后兼容，不误伤旧调用点）', () => {
    assert.equal(decideContinuation(input({ productivity: undefined })).proceed, true)
  })
})

describe('decideHandsContinuation', () => {
  function handsInput(over: Partial<HandsContinuationInput> = {}): HandsContinuationInput {
    return { result: result(), attempt: 0, extraRunsUsed: 0, aborted: false, ...over }
  }

  it('预算耗尽的写工在工作树内续跑', () => {
    for (const reason of ['max_turns', 'timeout'] as const) {
      const decision = decideHandsContinuation(handsInput({ result: result({ failureReason: reason }) }))
      assert.equal(decision.proceed, true, `${reason} 应触发续跑`)
      if (decision.proceed) assert.equal(decision.reason, reason)
    }
  })

  it('非预算失败、已中止、超上限都不续', () => {
    assert.equal(decideHandsContinuation(handsInput({ result: result({ failureReason: 'json_parse' }) })).proceed, false)
    assert.equal(decideHandsContinuation(handsInput({ result: result({ failureReason: undefined }) })).proceed, false)
    assert.equal(decideHandsContinuation(handsInput({ aborted: true })).proceed, false)
    assert.equal(decideHandsContinuation(handsInput({ attempt: MAX_BUDGET_CONTINUATIONS })).proceed, false)
  })

  it('与解析修复/闸门修复共用总账，且给闸门修复留一格', () => {
    const budget = MAX_HANDS_EXTRA_RUNS - HANDS_GATE_REPAIR_RESERVE
    for (let used = 0; used < budget; used++) {
      assert.equal(decideHandsContinuation(handsInput({ extraRunsUsed: used })).proceed, true, `已用 ${used} 轮应放行`)
    }
    const exhausted = decideHandsContinuation(handsInput({ extraRunsUsed: budget }))
    assert.equal(exhausted.proceed, false)
    if (!exhausted.proceed) assert.match(exhausted.skipReason, /写闸门修复/)
  })
})

describe('buildContinuationObjective', () => {
  it('告诉 worker 这是接着干，并带上原始目标', () => {
    const text = buildContinuationObjective('定位路由接缝', 'max_turns', 1)
    assert.match(text, /第 1 次续跑/)
    assert.match(text, /轮次预算/)
    assert.match(text, /不要重做/)
    assert.match(text, /定位路由接缝/)
  })

  it('区分轮次耗尽与时间耗尽', () => {
    assert.match(buildContinuationObjective('x', 'timeout', 2), /时间预算/)
    assert.doesNotMatch(buildContinuationObjective('x', 'timeout', 2), /轮次预算/)
  })
})

describe('markContinued', () => {
  it('在 risks 上留痕，且幂等', () => {
    const once = markContinued(result({ risks: ['既有风险'] }), 2, 'max_turns')
    assert.equal(once.risks.length, 2)
    assert.match(once.risks[1]!, /budget-continuation/)
    assert.match(once.risks[1]!, /续跑 2 次/)

    const twice = markContinued(once, 2, 'max_turns')
    assert.equal(twice.risks.length, 2, '重复标注不该叠加')
  })

  it('不改动原对象', () => {
    const original = result()
    markContinued(original, 1, 'timeout')
    assert.equal(original.risks.length, 0)
  })
})

describe('mergeUsage', () => {
  it('逐字段累加，缺项按 0 计', () => {
    const merged = mergeUsage({ input_tokens: 10, output_tokens: 3 }, { input_tokens: 5, cache_read_input_tokens: 7 })
    assert.deepEqual(merged, { input_tokens: 15, output_tokens: 3, cache_read_input_tokens: 7 })
  })

  it('任一侧缺席时原样返回另一侧', () => {
    assert.deepEqual(mergeUsage(undefined, { input_tokens: 4 }), { input_tokens: 4 })
    assert.deepEqual(mergeUsage({ input_tokens: 4 }, undefined), { input_tokens: 4 })
    assert.equal(mergeUsage(undefined, undefined), undefined)
  })
})
