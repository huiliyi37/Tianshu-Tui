import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { validatePlanContentForApproval } from '../plan.js'

/**
 * Empty/invalid-plan hard-fail at the approval boundary (kimi-code borrow).
 * `/plan-approve` and the plan-picker call this before writing the APPROVED
 * marker / kicking off execution, so a stale draft or gutted file cannot be
 * approved as if it were a finished plan.
 */
describe('validatePlanContentForApproval', () => {
  const CONCRETE_PLAN = [
    '# Real Plan',
    '',
    '## 根因分析',
    '循环边界未重置导致计数错误。',
    '',
    '## 实现方案',
    '```mermaid',
    'flowchart TD',
    '    A[输入] --> B{边界?}',
    '```',
    '',
    '修改 `src/agent/loop.ts:120`。',
    '',
    '## 验证',
    '运行 `npm test`。',
  ].join('\n')

  it('accepts a concrete, fully-written plan', () => {
    assert.deepEqual(validatePlanContentForApproval(CONCRETE_PLAN), { ok: true })
  })

  it('rejects an empty plan', () => {
    const r = validatePlanContentForApproval('   \n  \n')
    assert.equal(r.ok, false)
    assert.match(r.reason!, /空/)
  })

  it('rejects a plan that is only status markers (no body)', () => {
    const r = validatePlanContentForApproval('> **Status: APPROVED** — 2026-07-04T00:00:00.000Z\n\n')
    assert.equal(r.ok, false)
    assert.match(r.reason!, /空/)
  })

  it('rejects a plan riddled with placeholders', () => {
    const plan = [
      '# Draft',
      '## 根因分析',
      'TODO figure this out',
      '## 实现方案',
      'FIXME add design',
      '## 验证',
      'TBD write tests',
    ].join('\n')
    const r = validatePlanContentForApproval(plan)
    assert.equal(r.ok, false)
    assert.match(r.reason!, /占位符/)
  })

  it('rejects a plan with only-title empty sections', () => {
    const plan = [
      '# Draft',
      '',
      '## 根因分析',
      '',
      '## 实现方案',
      '',
    ].join('\n')
    const r = validatePlanContentForApproval(plan)
    assert.equal(r.ok, false)
  })
})
