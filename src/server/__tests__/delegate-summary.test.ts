import { test } from 'node:test'
import assert from 'node:assert/strict'
import { buildDelegateSummary } from '../serve.js'
import type { CoordinatorRun } from '../../agent/coordinator.js'

function run(over: Partial<CoordinatorRun['results'][number]>, status: CoordinatorRun['status'] = 'completed'): CoordinatorRun {
  return {
    status,
    results: [{
      workOrderId: 'user:abc',
      status: 'passed',
      summary: 'did the thing',
      findings: [],
      artifacts: [],
      changedFiles: [],
      risks: [],
      nextActions: [],
      evidenceStatus: 'unverified',
      ...over,
    }],
  } as unknown as CoordinatorRun
}

test('buildDelegateSummary: includes objective + outcome label', () => {
  const text = buildDelegateSummary({ objective: '查验证码' }, run({ status: 'passed' }))
  assert.match(text, /查验证码/)
  assert.match(text, /完成/)
})

test('buildDelegateSummary: lists changed files', () => {
  const text = buildDelegateSummary({ objective: 'x' }, run({ status: 'passed', changedFiles: ['a.ts', 'b.ts'] }))
  assert.match(text, /变更文件/)
  assert.match(text, /- a\.ts/)
  assert.match(text, /- b\.ts/)
})

test('buildDelegateSummary: truncates very long worker summary', () => {
  const long = 'x'.repeat(5000)
  const text = buildDelegateSummary({ objective: 'x' }, run({ status: 'passed', summary: long }))
  // Worker summary slice cap is 1200 chars; full 5000 must not appear verbatim.
  assert.ok(!text.includes(long))
})

test('buildDelegateSummary: blocked status maps to 受阻', () => {
  const text = buildDelegateSummary({ objective: 'x' }, run({ status: 'blocked' }))
  assert.match(text, /受阻/)
})
