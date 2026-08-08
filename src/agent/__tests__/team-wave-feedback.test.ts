import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import {
  buildPriorWaveFeedback,
  MAX_FEEDBACK_ENTRIES,
  MAX_FEEDBACK_ENTRY_CHARS,
  MAX_LEAKED_FILES,
} from '../team-wave-feedback.js'
import type { WorkerResult } from '../work-order.js'

function result(overrides: Partial<WorkerResult> & { workOrderId: string }): WorkerResult {
  return {
    status: 'passed',
    summary: '',
    findings: [],
    artifacts: [],
    changedFiles: [],
    risks: [],
    nextActions: [],
    evidenceStatus: 'unverified',
    ...overrides,
  } as WorkerResult
}

describe('buildPriorWaveFeedback — 只下传坏消息', () => {
  test('无输入时返回空数组（调用方据此不注入任何字段）', () => {
    assert.deepEqual(buildPriorWaveFeedback({}), [])
  })

  test('全员通过时不产生回执——产物在共享工作树里，复述只是噪音', () => {
    const out = buildPriorWaveFeedback({
      priorResults: [
        result({ workOrderId: 'team:T1', summary: '完成了 A' }),
        result({ workOrderId: 'team:T2', summary: '完成了 B' }),
      ],
    })
    assert.deepEqual(out, [])
  })

  test('失败 worker 被点名，带 taskId 与状态', () => {
    const out = buildPriorWaveFeedback({
      priorResults: [
        result({ workOrderId: 'team:T1' }),
        result({ workOrderId: 'team:T2', status: 'failed', failureReason: 'timeout' }),
      ],
    })
    assert.equal(out.length, 1)
    assert.match(out[0]!, /T2/)
    assert.match(out[0]!, /failed/)
    assert.match(out[0]!, /timeout/)
  })

  test('blocked / skipped 同样下传（下游要知道上游为何没跑）', () => {
    const out = buildPriorWaveFeedback({
      priorResults: [
        result({ workOrderId: 'team:T3', status: 'blocked', risks: ['blocked by prior wave failure (T2)'] }),
        result({ workOrderId: 'team:T4', status: 'escalated' }),
      ],
    })
    assert.equal(out.length, 2)
    assert.match(out[0]!, /T3/)
    assert.match(out[1]!, /T4/)
  })

  test('归因优先级：failureReason > risks > summary', () => {
    const byReason = buildPriorWaveFeedback({
      priorResults: [result({
        workOrderId: 'team:A', status: 'failed',
        failureReason: 'json_parse', risks: ['risk text'], summary: 'summary text',
      })],
    })
    assert.match(byReason[0]!, /json_parse/)

    const byRisk = buildPriorWaveFeedback({
      priorResults: [result({
        workOrderId: 'team:B', status: 'failed', risks: ['risk text'], summary: 'summary text',
      })],
    })
    assert.match(byRisk[0]!, /risk text/)

    const bySummary = buildPriorWaveFeedback({
      priorResults: [result({ workOrderId: 'team:C', status: 'failed', summary: 'summary text' })],
    })
    assert.match(bySummary[0]!, /summary text/)
  })

  test('三者皆空时只报状态，不编造原因', () => {
    const out = buildPriorWaveFeedback({
      priorResults: [result({ workOrderId: 'team:D', status: 'failed' })],
    })
    assert.equal(out[0], '上一波 D failed')
  })

  test('workOrderId 带多级前缀时正确提取 taskId', () => {
    const out = buildPriorWaveFeedback({
      priorResults: [result({ workOrderId: 'team:wave1:team:T7', status: 'failed' })],
    })
    assert.match(out[0]!, /\bT7\b/)
  })
})

describe('buildPriorWaveFeedback — 门禁与范围', () => {
  test('波间门禁失败项下传', () => {
    const out = buildPriorWaveFeedback({ waveGateFailures: ['typecheck', 'npm test'] })
    assert.equal(out.length, 1)
    assert.match(out[0]!, /门禁未过/)
    assert.match(out[0]!, /typecheck/)
  })

  test('scope 泄漏点名文件并提示勿扩大范围', () => {
    const out = buildPriorWaveFeedback({ scopeLeaks: ['src/a.ts', 'src/b.ts'] })
    assert.equal(out.length, 1)
    assert.match(out[0]!, /计划外改动/)
    assert.match(out[0]!, /src\/a\.ts/)
    assert.match(out[0]!, /勿扩大范围/)
  })

  test('泄漏文件过多时只点名前几个并给出总数', () => {
    const leaks = Array.from({ length: 9 }, (_, i) => `src/f${i}.ts`)
    const out = buildPriorWaveFeedback({ scopeLeaks: leaks })
    assert.match(out[0]!, new RegExp(`等 ${leaks.length} 处`))
    assert.ok(!out[0]!.includes(`f${MAX_LEAKED_FILES + 1}`))
  })

  test('空白项被过滤，不产生空回执', () => {
    assert.deepEqual(buildPriorWaveFeedback({ waveGateFailures: ['', '  '] }), [])
    assert.deepEqual(buildPriorWaveFeedback({ scopeLeaks: ['', '  '] }), [])
  })
})

describe('buildPriorWaveFeedback — 体量护栏', () => {
  test('单条超长被截断（worker prompt 里 constraints 是单行拼接）', () => {
    const out = buildPriorWaveFeedback({
      priorResults: [result({
        workOrderId: 'team:T1', status: 'failed', summary: 'x'.repeat(500),
      })],
    })
    assert.ok(out[0]!.length <= MAX_FEEDBACK_ENTRY_CHARS, `实际 ${out[0]!.length}`)
    assert.match(out[0]!, /…$/)
  })

  test('条数封顶，超出部分折叠为一条省略提示', () => {
    const many = Array.from({ length: 12 }, (_, i) =>
      result({ workOrderId: `team:T${i}`, status: 'failed' as const }))
    const out = buildPriorWaveFeedback({ priorResults: many })
    assert.equal(out.length, MAX_FEEDBACK_ENTRIES)
    assert.match(out[out.length - 1]!, /已省略/)
  })

  test('换行与多余空白被压平——constraints 单行渲染不能被撑破', () => {
    const out = buildPriorWaveFeedback({
      priorResults: [result({
        workOrderId: 'team:T1', status: 'failed', summary: 'line one\n\nline  two\ttab',
      })],
    })
    assert.ok(!out[0]!.includes('\n'))
    assert.match(out[0]!, /line one line two tab/)
  })

  test('确定性：同样输入产出同样字节（不引入时间戳/随机序）', () => {
    const input = {
      priorResults: [result({ workOrderId: 'team:T1', status: 'failed' as const, failureReason: 'timeout' })],
      waveGateFailures: ['typecheck'],
      scopeLeaks: ['src/a.ts'],
    }
    assert.deepEqual(buildPriorWaveFeedback(input), buildPriorWaveFeedback(input))
  })

  test('三类反馈共存时顺序稳定：worker → 门禁 → 范围', () => {
    const out = buildPriorWaveFeedback({
      priorResults: [result({ workOrderId: 'team:T1', status: 'failed' })],
      waveGateFailures: ['typecheck'],
      scopeLeaks: ['src/a.ts'],
    })
    assert.equal(out.length, 3)
    assert.match(out[0]!, /T1/)
    assert.match(out[1]!, /门禁/)
    assert.match(out[2]!, /计划外改动/)
  })
})
