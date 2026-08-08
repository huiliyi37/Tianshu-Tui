import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { AdvisoryReadback } from '../advisory-readback.js'
import { createAdvisoryReadbackHooks } from '../hooks/advisory-readback-hook.js'
import { ADVISORY_UNRESOLVED_KIND, ADVISORY_OUTCOME_KIND } from '../telemetry-writer.js'
import { RuntimeHookPipeline, createRuntimeHookContext, type RuntimeHookContext } from '../runtime-hooks.js'

function ctxAt(turn: number): RuntimeHookContext {
  return { snapshot: { turn } } as unknown as RuntimeHookContext
}

type ExpectKind = 'tool_appears' | 'verify_attempted' | 'pattern_absent'

function delivered(key: string, kind: ExpectKind = 'verify_attempted', withinTurns?: number) {
  return {
    key,
    category: 'discipline' as const,
    expect: { kind, ...(withinTurns !== undefined ? { withinTurns } : {}) } as never,
  }
}

describe('AdvisoryReadback.flushAtSessionEnd', () => {
  test('到期且已满足的照常判 adopted', () => {
    const rb = new AdvisoryReadback()
    rb.track([delivered('k', 'verify_attempted', 2)], 1)
    rb.observeTool({ turn: 1, name: 'run_tests', target: '', isError: false })

    const { decided, unresolved } = rb.flushAtSessionEnd(2)
    assert.equal(decided, 1)
    assert.deepEqual(unresolved, [])
    assert.equal(rb.getTotals().adopted, 1)
  })

  test('到期但未满足的照常判 ignored', () => {
    const rb = new AdvisoryReadback()
    rb.track([delivered('k', 'verify_attempted', 2)], 1)

    const { decided, unresolved } = rb.flushAtSessionEnd(5)
    assert.equal(decided, 1)
    assert.deepEqual(unresolved, [])
    assert.equal(rb.getTotals().ignored, 1)
  })

  // 核心语义：末轮送达的 advisory 没有走完窗口的机会，判 ignored 会把
  // 「没机会响应」记成「听了不做」，进而经 ignoredStreak / efficacy / lift
  // 三条路径压低效力评分，静音掉本可能有效的提醒。
  test('未到期的不判 ignored，不进 adopted/ignored 账本', () => {
    const rb = new AdvisoryReadback()
    rb.track([delivered('late', 'pattern_absent')], 5) // 默认窗口 4 轮

    const { decided, unresolved } = rb.flushAtSessionEnd(5)
    assert.equal(decided, 0)
    assert.equal(unresolved.length, 1)
    assert.equal(rb.getTotals().ignored, 0, '未到期不得计入 ignored')
    assert.equal(rb.getTotals().adopted, 0)
  })

  test('未到期不推高 ignoredStreak（不触发习惯化静音）', () => {
    const rb = new AdvisoryReadback()
    rb.track([delivered('late', 'pattern_absent')], 9)
    rb.flushAtSessionEnd(9)
    assert.equal(rb.getIgnoredStreak('late'), 0)
  })

  test('unresolved 报出 key / 送达轮 / 还差几轮', () => {
    const rb = new AdvisoryReadback()
    rb.track([delivered('late', 'verify_attempted', 4)], 10)

    const { unresolved } = rb.flushAtSessionEnd(11)
    assert.equal(unresolved.length, 1)
    const u = unresolved[0]!
    assert.equal(u.key, 'late')
    assert.equal(u.expectKind, 'verify_attempted')
    assert.equal(u.deliveredTurn, 10)
    // deadline = 10 + 4 - 1 = 13，在 turn 11 结束 → 还差 2 轮
    assert.equal(u.turnsShort, 2)
  })

  test('到期与未到期在同一次 flush 中正确分流', () => {
    const rb = new AdvisoryReadback()
    rb.track([delivered('due', 'verify_attempted', 2)], 1)
    rb.track([delivered('early', 'pattern_absent')], 5)

    const { decided, unresolved } = rb.flushAtSessionEnd(5)
    assert.equal(decided, 1)
    assert.deepEqual(unresolved.map(u => u.key), ['early'])
  })

  test('flush 后 pending 清空，重复调用幂等', () => {
    const rb = new AdvisoryReadback()
    rb.track([delivered('late', 'pattern_absent')], 9)

    const first = rb.flushAtSessionEnd(9)
    assert.equal(first.unresolved.length, 1)
    const second = rb.flushAtSessionEnd(9)
    assert.equal(second.decided, 0)
    assert.equal(second.unresolved.length, 0)
  })

  test('无 pending 时是零开销 no-op', () => {
    const rb = new AdvisoryReadback()
    const { decided, unresolved } = rb.flushAtSessionEnd(3)
    assert.equal(decided, 0)
    assert.deepEqual(unresolved, [])
  })

  test('shadow 送达未到期时也如实标记，不进 shadow 桶', () => {
    const rb = new AdvisoryReadback()
    rb.track([{ ...delivered('s', 'pattern_absent'), shadow: true }], 9)

    const { unresolved } = rb.flushAtSessionEnd(9)
    assert.equal(unresolved.length, 1)
    assert.equal(unresolved[0]!.shadow, true)
    assert.equal(rb.getStats().get('s')?.shadowSatisfied ?? 0, 0)
  })
})

describe('advisory-readback-finalize postSession hook', () => {
  test('hook 三元组包含 postSession 半边', () => {
    const rb = new AdvisoryReadback()
    const hooks = createAdvisoryReadbackHooks({ readback: rb })
    assert.equal(hooks.length, 3)
    assert.deepEqual(hooks.map(h => h.phase), ['postTool', 'postTurn', 'postSession'])
  })

  test('未决送达写出 advisory-unresolved 汇总（每会话一条）', () => {
    const rb = new AdvisoryReadback()
    const records: Array<{ kind: string } & Record<string, unknown>> = []
    const [, , finalize] = createAdvisoryReadbackHooks({
      readback: rb,
      writeTelemetry: r => { records.push(r) },
    })

    rb.track([delivered('a', 'pattern_absent'), delivered('b', 'pattern_absent')], 9)
    rb.track([delivered('a', 'pattern_absent')], 9)
    finalize.run(ctxAt(9))

    const summary = records.filter(r => r.kind === ADVISORY_UNRESOLVED_KIND)
    assert.equal(summary.length, 1, '每会话只写一条汇总')
    assert.equal(summary[0]!.count, 2)
    assert.deepEqual(summary[0]!.byKey, { a: 1, b: 1 })
  })

  test('到期判定在 postSession 仍会落 advisory-outcome 与 totals 回调', () => {
    const rb = new AdvisoryReadback()
    const records: Array<{ kind: string } & Record<string, unknown>> = []
    let totals: { adopted: number; ignored: number } | null = null
    const [, , finalize] = createAdvisoryReadbackHooks({
      readback: rb,
      writeTelemetry: r => { records.push(r) },
      onOutcomes: t => { totals = t },
    })

    rb.track([delivered('k', 'verify_attempted', 2)], 1)
    rb.observeTool({ turn: 1, name: 'run_tests', target: '', isError: false })
    finalize.run(ctxAt(2))

    assert.equal(records.filter(r => r.kind === ADVISORY_OUTCOME_KIND).length, 1)
    assert.deepEqual(totals, { adopted: 1, ignored: 0 })
  })

  test('无 pending 时 postSession 不写任何遥测', () => {
    const rb = new AdvisoryReadback()
    const records: Array<{ kind: string }> = []
    const [, , finalize] = createAdvisoryReadbackHooks({
      readback: rb,
      writeTelemetry: r => { records.push(r) },
    })

    finalize.run(ctxAt(4))
    assert.deepEqual(records, [])
  })

  // 装配契约：hook 自身正确不代表它会被执行——三元组要能被真实 pipeline
  // 注册进 postSession 阶段并在该阶段跑到。
  test('真实 RuntimeHookPipeline 在 postSession 阶段执行 finalize', async () => {
    const rb = new AdvisoryReadback()
    const records: Array<{ kind: string } & Record<string, unknown>> = []
    const pipeline = new RuntimeHookPipeline(
      createAdvisoryReadbackHooks({ readback: rb, writeTelemetry: r => { records.push(r) } }),
    )

    rb.track([delivered('late', 'pattern_absent')], 9)
    await pipeline.runPostSession(createRuntimeHookContext(
      { turn: 9 } as never,
      {},
    ))

    assert.equal(records.filter(r => r.kind === ADVISORY_UNRESOLVED_KIND).length, 1)
  })
})
