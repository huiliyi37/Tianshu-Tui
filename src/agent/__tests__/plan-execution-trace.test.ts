import { describe, it } from 'node:test'
import assert from 'node:assert/strict'

import {
  createTrace,
  appendResult,
  detectDeviation,
  serializeTrace,
  maxStepsForDepth,
  type PlanStep,
  type StepResult,
} from '../plan-execution-trace.js'

// ─── Helpers ───────────────────────────────────────────────────

function makeStep(id: string, expectedTools: string[] = ['read_file'], overrides: Partial<PlanStep> = {}): PlanStep {
  return {
    id,
    description: `Step ${id}`,
    expectedTools,
    status: 'pending',
    ...overrides,
  }
}

function makeResult(
  stepId: string,
  turn: number,
  overrides: Partial<StepResult> = {},
): StepResult {
  return {
    stepId,
    turnNumber: turn,
    toolCalls: [{ tool: 'read_file', result_summary: 'ok' }],
    status: 'done',
    ...overrides,
  }
}

// ─── createTrace ───────────────────────────────────────────────

describe('createTrace', () => {
  it('creates trace with contractId and depthLayer', () => {
    const trace = createTrace('contract-1', 'unit')
    assert.equal(trace.contractId, 'contract-1')
    assert.equal(trace.depthLayer, 'unit')
    assert.equal(trace.status, 'active')
    assert.deepEqual(trace.steps, [])
    assert.deepEqual(trace.history, [])
  })

  it('accepts initial steps', () => {
    const steps = [makeStep('step-1'), makeStep('step-2')]
    const trace = createTrace('c1', 'wiring', steps)
    assert.equal(trace.steps.length, 2)
  })
})

// ─── maxStepsForDepth ──────────────────────────────────────────

describe('maxStepsForDepth', () => {
  it('unit → 3', () => assert.equal(maxStepsForDepth('unit'), 3))
  it('wiring → 5', () => assert.equal(maxStepsForDepth('wiring'), 5))
  it('system → 8', () => assert.equal(maxStepsForDepth('system'), 8))
})

// ─── appendResult ──────────────────────────────────────────────

describe('appendResult', () => {
  it('appends result to history', () => {
    const trace = createTrace('c1', 'unit', [makeStep('step-1')])
    const updated = appendResult(trace, makeResult('step-1', 1))
    assert.equal(updated.history.length, 1)
    assert.equal(updated.history[0]!.stepId, 'step-1')
  })

  it('marks step as done when result is done', () => {
    const trace = createTrace('c1', 'unit', [makeStep('step-1')])
    const updated = appendResult(trace, makeResult('step-1', 1, { status: 'done' }))
    assert.equal(updated.steps[0]!.status, 'done')
  })

  it('marks step as replanned when result is deviated', () => {
    const trace = createTrace('c1', 'unit', [makeStep('step-1')])
    const updated = appendResult(trace, makeResult('step-1', 1, { status: 'deviated' }))
    assert.equal(updated.steps[0]!.status, 'replanned')
  })

  it('trace status becomes blocked when result is blocked', () => {
    const trace = createTrace('c1', 'unit', [makeStep('step-1')])
    const updated = appendResult(trace, makeResult('step-1', 1, { status: 'blocked' }))
    assert.equal(updated.status, 'blocked')
  })

  it('does not mutate original trace', () => {
    const trace = createTrace('c1', 'unit', [makeStep('step-1')])
    const _updated = appendResult(trace, makeResult('step-1', 1))
    assert.equal(trace.history.length, 0) // original unchanged
    assert.equal(trace.steps[0]!.status, 'pending')
  })

  // 反证：StepResult 只包含工具名不包含结果摘要 → 测试会失败
  it('result summary is included for replan context', () => {
    const trace = createTrace('c1', 'unit', [makeStep('step-1')])
    const updated = appendResult(trace, makeResult('step-1', 1, {
      toolCalls: [{ tool: 'edit_file', result_summary: 'modified L5-L8' }],
    }))
    assert.equal(updated.history[0]!.toolCalls[0]!.result_summary, 'modified L5-L8')
  })
})

// ─── detectDeviation ───────────────────────────────────────────

describe('detectDeviation', () => {
  // 反证：忽略"新发现文件" → 测试会失败
  it('stray detection excludes files listed in StepResult.newFiles', () => {
    const trace = createTrace('c1', 'unit', [
      makeStep('step-1', ['edit_file']),
    ])
    // Agent used read_file (not in expectedTools) but found a new file
    const result = makeResult('step-1', 1, {
      toolCalls: [{ tool: 'read_file', result_summary: 'read new file' }],
      status: 'done',
      newFiles: ['src/new-module.ts'],
    })
    const dev = detectDeviation(trace, result)
    // stray (not deviated) because newFiles present and tool is exploratory
    assert.equal(dev.type, 'stray')
  })

  it('detects blocked when 3+ consecutive failures and convergence level >= 2', () => {
    let trace = createTrace('c1', 'unit', [makeStep('step-1')])
    trace = appendResult(trace, makeResult('step-1', 1, { status: 'blocked' }))
    trace = appendResult(trace, makeResult('step-1', 2, { status: 'blocked' }))
    trace = appendResult(trace, makeResult('step-1', 3, { status: 'blocked' }))

    const dev = detectDeviation(trace, undefined, 2)
    assert.equal(dev.type, 'blocked')
  })

  it('does not trigger blocked without convergence level', () => {
    let trace = createTrace('c1', 'unit', [makeStep('step-1')])
    trace = appendResult(trace, makeResult('step-1', 1, { status: 'blocked' }))
    trace = appendResult(trace, makeResult('step-1', 2, { status: 'blocked' }))
    trace = appendResult(trace, makeResult('step-1', 3, { status: 'blocked' }))

    const dev = detectDeviation(trace, undefined)
    assert.notEqual(dev.type, 'blocked')
  })

  it('detects stalled when noToolTurnCount >= 3', () => {
    const trace = createTrace('c1', 'unit', [makeStep('step-1')])
    const dev = detectDeviation(trace, undefined, 0, 3)
    assert.equal(dev.type, 'stalled')
  })

  it('does not trigger stalled when noToolTurnCount < 3', () => {
    const trace = createTrace('c1', 'unit', [makeStep('step-1')])
    const dev = detectDeviation(trace, undefined, 0, 2)
    assert.notEqual(dev.type, 'stalled')
  })

  it('detects deviated when toolCalls not in expectedTools', () => {
    const trace = createTrace('c1', 'unit', [
      makeStep('step-1', ['edit_file']),
    ])
    const result = makeResult('step-1', 1, {
      toolCalls: [{ tool: 'bash', result_summary: 'ran command' }],
      status: 'deviated',
    })
    const dev = detectDeviation(trace, result)
    assert.equal(dev.type, 'deviated')
  })

  it('returns none when toolCalls match expectedTools', () => {
    const trace = createTrace('c1', 'unit', [
      makeStep('step-1', ['read_file', 'grep']),
    ])
    const result = makeResult('step-1', 1, {
      toolCalls: [{ tool: 'read_file', result_summary: 'ok' }],
      status: 'done',
    })
    const dev = detectDeviation(trace, result)
    assert.equal(dev.type, 'none')
  })

  it('detects replanned when all steps done but trace not completed', () => {
    let trace = createTrace('c1', 'unit', [
      makeStep('step-1'),
      makeStep('step-2'),
    ])
    trace = appendResult(trace, makeResult('step-1', 1))
    trace = appendResult(trace, makeResult('step-2', 2))

    const dev = detectDeviation(trace, undefined)
    assert.equal(dev.type, 'replanned')
  })

  it('returns none for empty trace', () => {
    const trace = createTrace('c1', 'unit')
    const dev = detectDeviation(trace)
    assert.equal(dev.type, 'none')
  })
})

// ─── serializeTrace ────────────────────────────────────────────

describe('serializeTrace', () => {
  it('returns empty string for trace with no steps', () => {
    const trace = createTrace('c1', 'unit')
    assert.equal(serializeTrace(trace), '')
  })

  it('produces XML with steps and status', () => {
    const trace = createTrace('c1', 'unit', [
      makeStep('step-1'),
      makeStep('step-2', ['edit_file']),
    ])
    const xml = serializeTrace(trace)
    assert.ok(xml.includes('<plan-execution-trace'))
    assert.ok(xml.includes('step-1'))
    assert.ok(xml.includes('step-2'))
    assert.ok(xml.includes('</plan-execution-trace>'))
  })

  it('includes recent history (max 5)', () => {
    let trace = createTrace('c1', 'unit', [makeStep('step-1')])
    for (let i = 1; i <= 8; i++) {
      trace = appendResult(trace, makeResult('step-1', i))
    }
    const xml = serializeTrace(trace)
    assert.ok(xml.includes('<recent-history>'))
    // Should only show last 5 results
    const historyMatches = xml.match(/<result /g)
    assert.ok(historyMatches)
    assert.equal(historyMatches.length, 5)
  })

  // 反证：压缩后 trace 不被重新注入 → 序列化结果必须有完整标签
  it('serialized trace has complete XML structure', () => {
    const trace = createTrace('c1', 'system', [
      makeStep('step-1', ['read_file', 'grep']),
      makeStep('step-2', ['edit_file']),
    ])
    const xml = serializeTrace(trace)
    assert.ok(xml.includes('depth="system"'))
    assert.ok(xml.includes('status="active"'))
    assert.ok(xml.includes('id="step-1"'))
    assert.ok(xml.includes('id="step-2"'))
    assert.ok(xml.includes('status="pending"'))
  })

  it('escapes XML special characters in descriptions', () => {
    const trace = createTrace('c1', 'unit', [
      makeStep('step-1', [], { description: 'Read <script> & "quotes"' }),
    ])
    const xml = serializeTrace(trace)
    assert.ok(!xml.includes('<script>'), 'unescaped < should not appear')
    assert.ok(xml.includes('&lt;script&gt;'))
    assert.ok(xml.includes('&amp;'))
    assert.ok(xml.includes('&quot;'))
  })
})
