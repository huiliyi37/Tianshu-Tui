import { describe, it } from 'node:test'
import assert from 'node:assert/strict'

import {
  createTrace,
  appendResult,
  detectDeviation,
  serializeTrace,
  maxStepsForDepth,
  inferExpectedTools,
  buildPlanSteps,
  withPlanSteps,
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

  it('detects replanned when all steps done with sufficient history coverage', () => {
    let trace = createTrace('c1', 'unit', [
      makeStep('step-1'),
      makeStep('step-2'),
    ])
    trace = appendResult(trace, makeResult('step-1', 1))
    trace = appendResult(trace, makeResult('step-2', 2))

    const dev = detectDeviation(trace, undefined)
    assert.equal(dev.type, 'replanned')
  })

  // ── 反证：history 覆盖不足时不触发 replanned（防止虚假收敛）──
  // 场景：agent 在一个 turn 里标记所有 step done 但只有 1 条 history。
  // step "done" 只代表工具没报错，不代表目标真完成。
  it('does NOT trigger replanned when history does not cover all steps', () => {
    let trace = createTrace('c1', 'unit', [
      makeStep('step-1'),
      makeStep('step-2'),
      makeStep('step-3'),
    ])
    // 只有 1 条 history——agent 可能在同一轮把所有 step 标记 done
    trace = appendResult(trace, makeResult('step-1', 1))
    // 手动标记其余为 done（模拟 buildStepResultFromTurn 的批量标记场景）
    trace = { ...trace, steps: trace.steps.map(s => ({ ...s, status: 'done' as const })) }

    const dev = detectDeviation(trace, undefined)
    assert.notEqual(dev.type, 'replanned', 'history coverage < steps → 不应触发 replanned')
  })

  // 守卫边界：history.length === steps.length 刚好触发
  it('triggers replanned at exact coverage boundary (history == steps)', () => {
    let trace = createTrace('c1', 'unit', [
      makeStep('step-1'),
      makeStep('step-2'),
    ])
    trace = appendResult(trace, makeResult('step-1', 1))
    trace = appendResult(trace, makeResult('step-2', 2))
    // 2 steps, 2 history → 刚好满足
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

// ─── inferExpectedTools (U3) ──────────────────────────────────

describe('inferExpectedTools', () => {
  it('returns base tools when no LSP trigger keywords', () => {
    const tools = inferExpectedTools('修改配置文件')
    assert.deepEqual(tools, ['read_file'])
  })

  it('adds LSP tools when description contains "调用方"', () => {
    const tools = inferExpectedTools('查找 processPayment 的调用方')
    assert.ok(tools.includes('lsp_find_references'))
    assert.ok(tools.includes('lsp_goto_definition'))
  })

  it('adds LSP tools when description contains "理解"', () => {
    const tools = inferExpectedTools('理解现有数据流')
    assert.ok(tools.includes('lsp_find_references'))
  })

  it('adds LSP tools when description contains "依赖"', () => {
    const tools = inferExpectedTools('追踪模块依赖关系')
    assert.ok(tools.includes('lsp_goto_definition'))
  })

  it('does not duplicate tools already in baseTools', () => {
    const tools = inferExpectedTools('理解调用方', ['read_file', 'lsp_find_references'])
    const refs = tools.filter(t => t === 'lsp_find_references')
    assert.equal(refs.length, 1)
  })

  it('preserves custom baseTools', () => {
    const tools = inferExpectedTools('简单修改', ['edit_file', 'grep'])
    assert.deepEqual(tools, ['edit_file', 'grep'])
  })
})

// ─── buildPlanSteps (U6/C1) ───────────────────────────────────

describe('buildPlanSteps', () => {
  it('maps descriptions to PlanStep with sequential ids and pending status', () => {
    const steps = buildPlanSteps(['读取配置', '修改逻辑'], 'wiring')
    assert.equal(steps.length, 2)
    assert.equal(steps[0]!.id, 'step-1')
    assert.equal(steps[1]!.id, 'step-2')
    assert.equal(steps[0]!.description, '读取配置')
    assert.ok(steps.every(s => s.status === 'pending'))
  })

  it('populates expectedTools via inferExpectedTools (LSP keyword → lsp_*)', () => {
    const [step] = buildPlanSteps(['追踪 processPayment 的调用方'], 'unit')
    assert.ok(step!.expectedTools.includes('lsp_find_references'))
    assert.ok(step!.expectedTools.includes('lsp_goto_definition'))
  })

  it('non-LSP description gets only base tools', () => {
    const [step] = buildPlanSteps(['修改配置文件'], 'unit')
    assert.deepEqual(step!.expectedTools, ['read_file'])
  })

  it('caps step count at maxStepsForDepth (unit=3)', () => {
    const steps = buildPlanSteps(['s1', 's2', 's3', 's4', 's5'], 'unit')
    assert.equal(steps.length, 3)
  })

  it('caps step count at maxStepsForDepth (system=8)', () => {
    const ten = Array.from({ length: 10 }, (_, i) => `s${i}`)
    const steps = buildPlanSteps(ten, 'system')
    assert.equal(steps.length, maxStepsForDepth('system'))
  })

  it('filters blank/whitespace descriptions before numbering', () => {
    const steps = buildPlanSteps(['  ', '真步骤', '\t'], 'wiring')
    assert.equal(steps.length, 1)
    assert.equal(steps[0]!.id, 'step-1')
    assert.equal(steps[0]!.description, '真步骤')
  })

  it('empty input yields empty steps', () => {
    assert.deepEqual(buildPlanSteps([], 'system'), [])
  })
})

// ─── withPlanSteps (U6/C1) ────────────────────────────────────

describe('withPlanSteps', () => {
  it('fills steps when trace is empty (no steps, no history)', () => {
    const trace = createTrace('c1', 'wiring')
    const steps = buildPlanSteps(['a', 'b'], 'wiring')
    const filled = withPlanSteps(trace, steps)
    assert.equal(filled.steps.length, 2)
    assert.notEqual(filled, trace, 'returns a new trace (immutable)')
  })

  it('does not overwrite once steps exist', () => {
    const trace = createTrace('c1', 'unit', [makeStep('step-1')])
    const result = withPlanSteps(trace, buildPlanSteps(['x', 'y'], 'unit'))
    assert.equal(result.steps.length, 1)
    assert.equal(result, trace, 'returns the same trace unchanged')
  })

  it('does not overwrite once history exists (idempotent guard)', () => {
    const base = createTrace('c1', 'unit')
    const progressed = appendResult(base, makeResult('turn-1', 1))
    const result = withPlanSteps(progressed, buildPlanSteps(['x', 'y'], 'unit'))
    assert.equal(result.steps.length, 0)
    assert.equal(result.history.length, 1)
  })
})
