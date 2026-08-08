/**
 * Essence-gate hook 超时层级契约测试（主控可靠性闭环 Wave 1）。
 *
 * 核心契约（修复的假超时）：
 * - hook 声明外层预算（20s）> 内层 LLM fail-closed（15s）——内层超时先返回
 * - 内层超时 → 账本落行（failedClosed + failureReason=timeout），知识零写入
 * - 外层 pipeline 不得把这一轮记成 timed_out（假超时）
 */
import { describe, it, beforeEach, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { createHash } from 'node:crypto'
import { memoryDir } from '../../config/paths.js'
import { createEssenceGateHook, type EssenceGateHookDeps } from '../hooks/essence-gate-hook.js'
import { runGateCompletion, type GateCompletionClient } from '../gate-completion.js'
import { RuntimeHookPipeline, createRuntimeHookContext, type RuntimeHookRunEvent } from '../runtime-hooks.js'
import { readGateLedger } from '../../memory/gate-ledger.js'

function ledgerPath(cwd: string): string {
  const hash = createHash('sha256').update(cwd).digest('hex').slice(0, 12)
  return join(memoryDir(hash), 'gate-ledger.jsonl')
}

/** 忽略 abort、永不返回的底层 stream——模拟最坏情况（生产由 runGateCompletion 的 race 保底）。 */
const neverClient: GateCompletionClient = {
  stream: async () => new Promise<void>(() => {}),
}

describe('essence-gate hook timeout hierarchy', () => {
  let cwd: string
  let events: RuntimeHookRunEvent[]

  beforeEach(() => {
    cwd = mkdtempSync(join(tmpdir(), 'rivet-essence-hook-'))
    events = []
  })

  after(() => {
    try { rmSync(cwd, { recursive: true, force: true }) } catch { /* ignore */ }
  })

  function makeDeps(overrides: Partial<EssenceGateHookDeps> = {}): EssenceGateHookDeps {
    return {
      cwd,
      sessionId: 'sess-1',
      getCandidates: () => [
        { text: 'Prefer connection pooling for database access in this repository', kind: 'fact', confidence: 0.8, origin: 'observation' },
      ],
      // 永不 resolve 的侧路 LLM——模拟底层 stream 忽略 abort 的最坏情况；
      // 超时有界性由 runGateCompletion 的 race 保证（生产同一实现）。
      complete: (prompt, timeoutMs) => runGateCompletion(neverClient, () => {}, prompt, timeoutMs),
      timeoutMs: 30, // 测试用短内层超时；生产 15s
      ...overrides,
    }
  }

  it('内层超时先完成 fail-closed：账本落行、知识零写入、外层不记 timed_out', async () => {
    const hook = createEssenceGateHook(makeDeps())
    // 外层预算 200ms > 内层 30ms——若层级修反（外层先炸），本测试会 timed_out
    const pipeline = new RuntimeHookPipeline([hook], {
      hookTimeoutMs: 200,
      onRun: event => events.push(event),
    })

    const start = Date.now()
    await pipeline.runPostSession(createRuntimeHookContext({
      cwd,
      turn: 1,
      recentToolHistory: [],
      sensorium: null,
      strategy: null,
      vigor: null,
      gitChangeRate: 0,
      season: null,
    }))
    const elapsed = Date.now() - start

    const runEvent = events.find(e => e.id === 'essence-gate')
    assert.ok(runEvent, 'hook 必须有运行事件')
    assert.equal(runEvent!.outcome, 'completed', '内层 fail-closed 先返回，外层不得记 timed_out')
    assert.ok(elapsed < 1500, `必须在内层超时点有界返回，实际 ${elapsed}ms`)

    // 账本落行：failedClosed + failureReason=timeout + 候选数 + 耗时
    assert.ok(existsSync(ledgerPath(cwd)), '账本必须落行')
    const rows = readGateLedger(cwd)
    assert.equal(rows.length, 1)
    assert.equal(rows[0]!.failedClosed, true)
    assert.equal(rows[0]!.failureReason, 'timeout')
    assert.equal(rows[0]!.candidateCount, 1)
    assert.ok(rows[0]!.durationMs !== undefined && rows[0]!.durationMs! >= 30)
  })

  it('无候选时跳过：不调 complete、不落账本', async () => {
    const calls: string[] = []
    const hook = createEssenceGateHook(makeDeps({
      getCandidates: () => [],
      complete: async prompt => { calls.push(prompt); return '[]' },
    }))
    const pipeline = new RuntimeHookPipeline([hook], { onRun: event => events.push(event) })

    await pipeline.runPostSession(createRuntimeHookContext({
      cwd,
      turn: 1,
      recentToolHistory: [],
      sensorium: null,
      strategy: null,
      vigor: null,
      gitChangeRate: 0,
      season: null,
    }))

    assert.deepEqual(calls, [], '无候选不得触发侧路调用')
    assert.equal(existsSync(ledgerPath(cwd)), false, '无候选不得落账本')
    const runEvent = events.find(e => e.id === 'essence-gate')
    assert.equal(runEvent!.outcome, 'completed')
  })

  it('hook 声明 20s 外层预算（生产值）', () => {
    const hook = createEssenceGateHook(makeDeps())
    // RuntimeHook 联合类型上的 budgetMs——直接断言 hook 对象
    assert.equal((hook as { budgetMs?: number }).budgetMs, 20_000)
  })

  it('账本行携带失败归因字段（invalid_output 分支）', async () => {
    const hook = createEssenceGateHook(makeDeps({
      complete: async () => 'not json at all',
    }))
    const pipeline = new RuntimeHookPipeline([hook], { onRun: event => events.push(event) })

    await pipeline.runPostSession(createRuntimeHookContext({
      cwd,
      turn: 1,
      recentToolHistory: [],
      sensorium: null,
      strategy: null,
      vigor: null,
      gitChangeRate: 0,
      season: null,
    }))

    const runEvent = events.find(e => e.id === 'essence-gate')
    assert.equal(runEvent!.outcome, 'completed')
    const rows = readGateLedger(cwd)
    assert.equal(rows[0]!.failedClosed, true)
    assert.equal(rows[0]!.failureReason, 'invalid_output')
    // 兼容性：旧字段仍在
    assert.ok(rows[0]!.admitted !== undefined)
  })
})
