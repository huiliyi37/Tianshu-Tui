/**
 * normalizeReviewVerdictStatus 纯函数测试（verdict ≠ status 契约改造）。
 *
 * 事故背景（2026-08-02）：审查 worker 把「发现 CRITICAL 缺陷」编码为
 * status: failed/escalated —— 报告解析全部成功却被计连败触发升级，findings
 * 还被 mapSquadronFindings 的 passed 过滤丢弃。归一规则：
 * review/verify 工单 + failed|escalated + 有 findings + 无基础设施失败标记
 * → passed；其余一律不动。
 */
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { normalizeReviewVerdictStatus } from '../work-order.js'
import type { WorkOrder, WorkerResult } from '../work-order.js'

function order(kind: WorkOrder['kind']): WorkOrder {
  return { id: 'wo-test', kind } as WorkOrder
}

function result(overrides: Partial<WorkerResult> = {}): WorkerResult {
  return {
    workOrderId: 'wo-test',
    status: 'failed',
    summary: '静态代码审查结论：发现一处降档钳制缺陷',
    findings: [{ claim: 'reasoningFloor 钳制零净效果', evidence: 'src/a.ts:10', confidence: 'high' }],
    artifacts: [],
    changedFiles: [],
    risks: [],
    nextActions: [],
    evidenceStatus: 'unverified',
    ...overrides,
  }
}

describe('normalizeReviewVerdictStatus', () => {
  it('review 工单 failed + findings → 归一为 passed 并留痕', () => {
    const out = normalizeReviewVerdictStatus(order('review'), result())
    assert.equal(out.status, 'passed')
    assert.ok(out.risks.some(r => r.includes('verdict-normalized')))
    assert.equal(out.findings.length, 1, 'findings 不丢')
  })

  it('review 工单 escalated + findings → 归一为 passed', () => {
    const out = normalizeReviewVerdictStatus(order('review'), result({ status: 'escalated' }))
    assert.equal(out.status, 'passed')
  })

  it('verify 工单同样归一', () => {
    const out = normalizeReviewVerdictStatus(order('verify'), result())
    assert.equal(out.status, 'passed')
  })

  it('blocked 不归一（预算/超时死亡是真实运行失败）', () => {
    const out = normalizeReviewVerdictStatus(order('review'), result({ status: 'blocked' }))
    assert.equal(out.status, 'blocked')
  })

  it('有 failureReason 不归一（基础设施失败标记在场）', () => {
    const out = normalizeReviewVerdictStatus(order('review'), result({ failureReason: 'worker_crash' }))
    assert.equal(out.status, 'failed')
  })

  it('有 parseErrorKind 不归一（salvage 的 findings 不是审查结论）', () => {
    const out = normalizeReviewVerdictStatus(order('review'), result({ parseErrorKind: 'json_syntax' }))
    assert.equal(out.status, 'failed')
  })

  it('无 findings 不归一（真失败而非 verdict 编码）', () => {
    const out = normalizeReviewVerdictStatus(order('review'), result({ findings: [] }))
    assert.equal(out.status, 'failed')
  })

  it('非审查类工单不归一', () => {
    const out = normalizeReviewVerdictStatus(order('code_search'), result())
    assert.equal(out.status, 'failed')
  })

  it('passed 原样通过', () => {
    const out = normalizeReviewVerdictStatus(order('review'), result({ status: 'passed' }))
    assert.equal(out.status, 'passed')
    assert.equal(out.risks.length, 0)
  })
})
