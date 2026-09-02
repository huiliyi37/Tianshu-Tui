import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { formatWorkerResultDigest } from '../worker-result-digest.js'

describe('formatWorkerResultDigest', () => {
  it('summarizes a passed result with finding count', () => {
    const d = formatWorkerResultDigest({ status: 'passed', summary: '定位到 3 处渲染函数', findingsCount: 3, changedFilesCount: 0 })
    assert.match(d, /✓/)
    assert.match(d, /定位到 3 处渲染函数/)
    assert.match(d, /3 条发现/)
  })

  it('summarizes a patch result with changed files', () => {
    const d = formatWorkerResultDigest({ status: 'passed', summary: '修复类型错误', findingsCount: 0, changedFilesCount: 2 })
    assert.match(d, /2 个文件/)
  })

  it('surfaces an honesty warning for a truncated/failed result', () => {
    const d = formatWorkerResultDigest({ status: 'blocked', summary: '部分完成', findingsCount: 0, changedFilesCount: 0, failureReason: 'max_turns' })
    assert.match(d, /⊗/)
    assert.match(d, /预算耗尽/)
  })

  it('evidenceStatus=failed 触发「验收证据验证失败」诚实警告', () => {
    const d = formatWorkerResultDigest({ status: 'failed', summary: '交付物未完成', findingsCount: 0, changedFilesCount: 1, evidenceStatus: 'failed' })
    assert.match(d, /✗/)
    assert.match(d, /⚠ 验收证据验证失败/)
  })

  it('failureReason 优先于 evidenceStatus（根因比信号更具体）', () => {
    const d = formatWorkerResultDigest({ status: 'failed', summary: 'x', findingsCount: 0, changedFilesCount: 0, failureReason: 'timeout', evidenceStatus: 'failed' })
    assert.match(d, /Worker 超时/)
    assert.doesNotMatch(d, /验收证据验证失败/)
  })

  it('evidenceStatus 非 failed 不产生警告', () => {
    const d = formatWorkerResultDigest({ status: 'passed', summary: 'x', findingsCount: 0, changedFilesCount: 0, evidenceStatus: 'verified' })
    assert.doesNotMatch(d, /⚠/)
  })

  it('sourcesReviewedCount 存在且 >0 时在文件数之后追加「N 个来源」', () => {
    const d = formatWorkerResultDigest({ status: 'passed', summary: '调研完成', findingsCount: 2, changedFilesCount: 1, sourcesReviewedCount: 12 })
    assert.match(d, /12 个来源/)
    // 顺序：文件数在前，来源数在后
    const idxFiles = d.indexOf('1 个文件')
    const idxSources = d.indexOf('12 个来源')
    assert.ok(idxFiles >= 0 && idxSources > idxFiles, '来源段应排在文件段之后')
  })

  it('sourcesReviewedCount 缺失或为 0 时不显示来源段', () => {
    const d0 = formatWorkerResultDigest({ status: 'passed', summary: 'x', findingsCount: 0, changedFilesCount: 0, sourcesReviewedCount: 0 })
    assert.doesNotMatch(d0, /个来源/)
    const dU = formatWorkerResultDigest({ status: 'passed', summary: 'x', findingsCount: 0, changedFilesCount: 0 })
    assert.doesNotMatch(dU, /个来源/)
  })

  it('salvagedFindingsCount > 0 时追加「未经核实」警告', () => {
    const d = formatWorkerResultDigest({
      status: 'blocked', summary: 'salvaged', findingsCount: 3, changedFilesCount: 0, salvagedFindingsCount: 2,
    })
    assert.match(d, /2 条打捞发现未经核实（引用可能为幻觉）/)
  })

  it('salvagedFindingsCount 缺失或为 0 时不显示打捞警告', () => {
    const d0 = formatWorkerResultDigest({ status: 'passed', summary: 'x', findingsCount: 1, changedFilesCount: 0, salvagedFindingsCount: 0 })
    assert.doesNotMatch(d0, /打捞发现未经核实/)
    const dU = formatWorkerResultDigest({ status: 'passed', summary: 'x', findingsCount: 1, changedFilesCount: 0 })
    assert.doesNotMatch(dU, /打捞发现未经核实/)
  })
})

describe('formatWorkerResultDigest — failureReason 12 值全映射（组合矩阵收口）', () => {
  const base = {
    status: 'failed' as const,
    summary: 'worker done',
    findingsCount: 0,
    changedFilesCount: 0,
  }
  // 文案来源：worker-result-digest.ts digestHonesty switch 分支。
  const cases: Array<[string, string]> = [
    ['max_turns', '预算耗尽'],
    ['stalled', '空跑'],
    ['json_parse', '结果解析失败'],
    ['worker_crash', 'Worker 异常终止'],
    ['timeout', 'Worker 超时'],
    ['caller_aborted', '已被取消'],
    ['worker_blocked', 'Worker 被阻断'],
    ['circuit_open', '熔断开启'],
    ['claim_conflict', '文件归属冲突'],
    ['schema_mismatch', '结果形状不符'],
    ['policy_short_circuit', '策略短路'],
    ['unknown', '失败原因未归类'],
  ]

  for (const [reason, label] of cases) {
    it(`${reason} → 「${label}」`, () => {
      const out = formatWorkerResultDigest({ ...base, failureReason: reason })
      assert.ok(out.includes(label), `expected digest to carry "${label}", got: ${out}`)
    })
  }
})
