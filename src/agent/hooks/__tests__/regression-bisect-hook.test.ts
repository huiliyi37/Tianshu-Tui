import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { createRegressionBisectHook, REGRESSION_LOOP_TURN_THRESHOLD } from '../regression-bisect-hook.js'
import type { AdvisoryEntry } from '../../advisory-bus.js'
import type { RuntimeHookContext, RuntimeToolEvent } from '../../runtime-hooks.js'

// Regression-Bisect 断路器（重构事故链缺口 4）：回归语义 + 连续只读诊断空转
// → 强制策略升级到基线对照（git log → bisect/checkpoint diff → 清单定位）。

function makeCtx(turn: number): RuntimeHookContext {
  return {
    snapshot: { cwd: '/fake', turn, recentToolHistory: [], sensorium: null },
    effects: {},
  } as unknown as RuntimeHookContext
}

function grep(pattern: string): RuntimeToolEvent {
  return { name: 'grep', success: true, input: { pattern } } as unknown as RuntimeToolEvent
}

function read(file: string): RuntimeToolEvent {
  return { name: 'read_file', success: true, input: { file_path: file } } as unknown as RuntimeToolEvent
}

function edit(file: string): RuntimeToolEvent {
  return { name: 'edit_file', success: true, input: { file_path: file } } as unknown as RuntimeToolEvent
}

function harness(objective: string | null = '排查设置页导航消失的回归') {
  const submitted: AdvisoryEntry[] = []
  const hook = createRegressionBisectHook({
    advisoryBus: { submit: (e: AdvisoryEntry) => { submitted.push(e) } },
    getObjective: () => objective,
  })
  return { submitted, hook }
}

/** 跑 n 轮纯诊断（每轮一个 grep + 一个 read）。 */
function runDiagnosisTurns(hook: ReturnType<typeof createRegressionBisectHook>, fromTurn: number, n: number): void {
  for (let i = 0; i < n; i++) {
    const ctx = makeCtx(fromTurn + i)
    hook.run(ctx, grep('nav'))
    hook.run(ctx, read('src/app.tsx'))
  }
}

describe('regression-bisect hook', () => {
  it('fires after threshold consecutive diagnosis-only turns with regression semantics in objective', () => {
    const { submitted, hook } = harness()
    runDiagnosisTurns(hook, 1, REGRESSION_LOOP_TURN_THRESHOLD)
    assert.equal(submitted.length, 1)
    const entry = submitted[0]!
    assert.equal(entry.key, 'regression-bisect')
    assert.equal(entry.tier, 'constitutional')
    assert.match(entry.content, /git log/)
    assert.match(entry.content, /git bisect/)
    assert.match(entry.content, /回归清单/)
  })

  it('carries a tool_appears expect predicate steering toward git history commands', () => {
    const { submitted, hook } = harness()
    runDiagnosisTurns(hook, 1, REGRESSION_LOOP_TURN_THRESHOLD)
    const expect = submitted[0]!.expect
    assert.ok(expect)
    assert.equal(expect!.kind, 'tool_appears')
    if (expect!.kind === 'tool_appears') {
      assert.ok(expect!.tools.includes('bash'))
      assert.equal(expect!.targetIncludes, 'git')
    }
  })

  it('stays silent without regression semantics anywhere', () => {
    const { submitted, hook } = harness('实现一个新的导出功能')
    runDiagnosisTurns(hook, 1, REGRESSION_LOOP_TURN_THRESHOLD + 3)
    assert.equal(submitted.length, 0)
  })

  it('detects regression semantics from tool inputs when objective is silent', () => {
    const { submitted, hook } = harness('继续')
    const ctx0 = makeCtx(1)
    hook.run(ctx0, grep('导航项消失'))
    runDiagnosisTurns(hook, 2, REGRESSION_LOOP_TURN_THRESHOLD)
    assert.equal(submitted.length, 1)
  })

  it('a successful write resets the loop counter and re-arms', () => {
    const { submitted, hook } = harness()
    runDiagnosisTurns(hook, 1, REGRESSION_LOOP_TURN_THRESHOLD - 1)
    // 阈值前一轮出现写入 → 计数清零
    const writeCtx = makeCtx(REGRESSION_LOOP_TURN_THRESHOLD)
    hook.run(writeCtx, edit('src/app.tsx'))
    runDiagnosisTurns(hook, REGRESSION_LOOP_TURN_THRESHOLD + 1, 2)
    assert.equal(submitted.length, 0, 'write broke the streak — counter restarted')
    // 再空转满阈值 → 触发
    runDiagnosisTurns(hook, REGRESSION_LOOP_TURN_THRESHOLD + 3, REGRESSION_LOOP_TURN_THRESHOLD)
    assert.equal(submitted.length, 1)
  })

  it('fires at most once until re-armed by a write', () => {
    const { submitted, hook } = harness()
    runDiagnosisTurns(hook, 1, REGRESSION_LOOP_TURN_THRESHOLD + 4)
    assert.equal(submitted.length, 1, 'no advisory spam while the loop continues')
  })

  it('read-only bash (git log / tests) counts as diagnosis', () => {
    const { submitted, hook } = harness()
    for (let i = 0; i < REGRESSION_LOOP_TURN_THRESHOLD; i++) {
      const ctx = makeCtx(i + 1)
      hook.run(ctx, { name: 'bash', success: true, input: { command: 'npm test' } } as unknown as RuntimeToolEvent)
    }
    assert.equal(submitted.length, 1)
  })
})
