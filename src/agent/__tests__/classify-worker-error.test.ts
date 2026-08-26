import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { classifyWorkerError, workerFailureResult } from '../coordinator.js'
import type { WorkOrder } from '../work-order.js'

// 正则来源：coordinator.ts classifyWorkerError 分支，每例对应该分支一条（行号随提交漂移，不写死）。
describe('classifyWorkerError — coordinator 兜底失败归类', () => {
  const cases: Array<[string, ReturnType<typeof classifyWorkerError>]> = [
    ['request timed out after 120000ms', 'timeout'],
    ['LLM request exceeded time budget', 'timeout'],
    ['The operation was aborted due to timeout', 'timeout'],
    ['response JSON parse failed: Unexpected token <', 'json_parse'],
    ['malformed JSON in worker output', 'json_parse'],
    ['schema validation failed: does not match workerResultSchema', 'schema_mismatch'],
    ['circuit open: too many failures', 'circuit_open'],
    // wrapAbort 构造的 stall-sweep 击杀消息（真实生产串，含 "aborted by stall sweep" 后缀）
    ['Worker wo_1 stalled: no activity for 45s (provider: deepseek) — upstream may be slow to first byte rather than dead; aborted by stall sweep', 'stalled'],
    ['Delegation aborted: caller signal fired', 'caller_aborted'],
    ['Aborted during backoff', 'caller_aborted'],
    ['Retry blocked: src/a.ts claimed by another session', 'claim_conflict'],
    ['worker process killed by signal 9', 'worker_crash'],
    ['ECONNRESET during stream', 'worker_crash'],
    ['The operation was aborted', 'unknown'],
    ['signal already used', 'unknown'],
    ['something entirely novel happened', 'unknown'],
  ]

  for (const [msg, expected] of cases) {
    it(`「${msg.slice(0, 32)}…」→ ${expected}`, () => {
      assert.equal(classifyWorkerError(new Error(msg)), expected)
    })
  }

  it('非 Error 输入取 String(error)', () => {
    assert.equal(classifyWorkerError('timed out!'), 'timeout')
  })
})

describe('workerFailureResult — 默认兜底接线', () => {
  const order = { id: 'wo_test' } as WorkOrder

  it('不传 opts 时按错误消息走推断（接线钉住）', () => {
    const r = workerFailureResult(order, new Error('worker process killed by signal 9'))
    assert.equal(r.failureReason, 'worker_crash')
    assert.equal(r.status, 'blocked')
    assert.equal(r.workOrderId, 'wo_test')
  })

  it('显式传 failureReason 时优先于推断', () => {
    const r = workerFailureResult(order, new Error('worker process killed by signal 9'), { failureReason: 'caller_aborted' })
    assert.equal(r.failureReason, 'caller_aborted')
  })
})
