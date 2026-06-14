import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { createRadioHook } from '../hooks/radio-hook.js'
import type { RuntimeHookContext, RuntimeHookSnapshot, RuntimeToolEvent } from '../runtime-hooks.js'
import type { Sensorium } from '../sensorium.js'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const DEFAULT_SENSORIUM: Sensorium = {
  momentum: 0.5, pressure: 0.3, confidence: 0.6,
  complexity: 0.4, freshness: 0.5, stability: 0.7,
}

function makeToolEntry(tool: string, target = '', status: 'success' | 'failed' = 'success') {
  return { tool, target, status }
}

function makeCtx(
  overrides: Partial<RuntimeHookSnapshot> = {},
  tool?: RuntimeToolEvent,
): { ctx: RuntimeHookContext; emitted: string[] } {
  const emitted: string[] = []
  const snapshot: RuntimeHookSnapshot = {
    cwd: '/tmp/test',
    turn: 1,
    recentToolHistory: [],
    sensorium: DEFAULT_SENSORIUM,
    strategy: null,
    vigor: null,
    gitChangeRate: 0,
    season: null,
    ...overrides,
  }
  return {
    ctx: {
      snapshot,
      effects: {
        setSensorium: () => {},
        setStrategy: () => {},
        setVigor: () => {},
        setGitChangeRate: () => {},
        injectUserMessage: () => {},
        requestThetaCheck: () => {},
        emitPhaseChange: (_phase: string, detail?: { reason?: string }) => {
          emitted.push(detail?.reason ?? _phase)
        },
        emitDecisionShift: () => {},
        markClaimStale: () => {},
      },
    },
    emitted,
  }
}

function runHook(
  hook: ReturnType<typeof createRadioHook>,
  snapshotOverrides: Partial<RuntimeHookSnapshot> = {},
  tool: RuntimeToolEvent = { name: 'read_file', success: true, target: 'src/app.ts' },
): string[] {
  const { ctx, emitted } = makeCtx(snapshotOverrides, tool)
  hook.run(ctx, tool)
  return emitted
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('TianshuRadioHook', () => {
  it('emits session_start on first tool call', () => {
    const hook = createRadioHook()
    const emitted = runHook(hook)
    assert.deepEqual(emitted, ['[天枢] 收到任务，开始分析。'])
  })

  it('does not emit session_start twice', () => {
    const hook = createRadioHook()
    runHook(hook)
    const second = runHook(hook)
    assert.equal(second.length, 0)
  })

  it('skips when sensorium is null', () => {
    const hook = createRadioHook()
    const emitted = runHook(hook, { sensorium: null })
    assert.equal(emitted.length, 0)
  })

  it('emits transition message on explore→plan phase change', () => {
    const hook = createRadioHook()

    // Turn 1: explore (tianxuan-locating — freshness 0.5 > 0.4, nothing else triggers)
    runHook(hook)

    // Turn 2: plan (tianshu-planning — low freshness + shouldEscalate, or freshness ≤ 0.4)
    // Use low freshness (0.2) + low confidence (0.3) to reach 'tianshu-planning' (class 'plan')
    const sensorium2: Sensorium = { ...DEFAULT_SENSORIUM, confidence: 0.3, freshness: 0.2 }
    const emitted2 = runHook(hook, { turn: 2, sensorium: sensorium2 })

    // formatRadioMessage strips {fileCount} when 0, so "0 个文件" becomes "个文件"
    assert.deepEqual(emitted2, ['[天枢] 已读取 个文件。准备制定方案。'])
  })

  it('does not emit on same-phase tool call', () => {
    const hook = createRadioHook()
    // Turn 1: explore → session_start
    runHook(hook)
    // Turn 2: still explore (same sensorium)
    const emitted2 = runHook(hook, { turn: 2 })
    assert.equal(emitted2.length, 0)
  })

  it('respects cooldown — no duplicate stuck messages within 5 turns', () => {
    const hook = createRadioHook()

    // Build 8 entries in recentToolHistory so that when the hook is called
    // on the next turn, it detects 8 consecutive same-phase entries.
    const toolHistory = Array.from({ length: 8 }, () => makeToolEntry('bash', 'echo hi'))

    // Turn 1: session_start
    runHook(hook, { turn: 1, recentToolHistory: [] })

    // Turn 9: detects stuck (8 consecutive explore entries in history)
    const emitted9 = runHook(hook, { turn: 9, recentToolHistory: toolHistory })
    assert.ok(emitted9.some(msg => msg.includes('可能遇到困难')))

    // Turns 10-13: within cooldown window — no stuck message
    for (let t = 10; t <= 13; t++) {
      const emitted = runHook(hook, { turn: t, recentToolHistory: toolHistory })
      const hasStuck = emitted.some(msg => msg.includes('可能遇到困难'))
      assert.equal(hasStuck, false, `expected no stuck on turn ${t}`)
    }

    // Turn 14: cooldown expired (14 - 9 = 5 = COOLDOWN_TURNS) — re-emits stuck
    const emitted14 = runHook(hook, { turn: 14, recentToolHistory: toolHistory })
    assert.ok(emitted14.some(msg => msg.includes('可能遇到困难')), 'expected stuck re-emission on turn 14')
  })

  it('emits test_fail on failed bash tool', () => {
    const hook = createRadioHook()

    // Turn 1: session_start (lastEmitTurn=1)
    runHook(hook, { turn: 1 })

    // Turn 2: bash fails but gap=1 < TEST_FAIL_COOLDOWN=2, nothing emitted
    const emitted2 = runHook(
      hook,
      { turn: 2 },
      { name: 'bash', success: false, target: 'npm test', isError: true },
    )
    assert.equal(emitted2.length, 0, `should not emit on turn 2 due to cooldown, got: ${JSON.stringify(emitted2)}`)

    // Turn 3: bash fails, gap=2 >= TEST_FAIL_COOLDOWN=2 → test_fail emits
    const emitted3 = runHook(
      hook,
      { turn: 3 },
      { name: 'bash', success: false, target: 'npm test', isError: true },
    )
    assert.ok(emitted3.some(msg => msg.includes('测试失败')), `expected test_fail, got: ${JSON.stringify(emitted3)}`)
  })

  it('does not emit test_fail on failed read_file', () => {
    const hook = createRadioHook()
    runHook(hook, { turn: 1 })

    const emitted = runHook(
      hook,
      { turn: 2 },
      { name: 'read_file', success: false, target: 'foo.ts', isError: true },
    )
    assert.equal(emitted.length, 0)
  })

  it('emits test_pass on successful test tool in verify phase', () => {
    const hook = createRadioHook()

    // Turn 1: read_file → 'explore' → session_start
    runHook(hook, { turn: 1 })

    // Turn 2: test_runner → 'verify' → phase transition (explore→verify) fires first
    const emitted2 = runHook(
      hook,
      { turn: 2 },
      { name: 'test_runner', success: true, target: 'tests/unit' },
    )
    assert.ok(emitted2.some(msg => msg.includes('试锋') || msg.includes('测试')), `expected transition, got: ${JSON.stringify(emitted2)}`)

    // Turn 3: still 'verify', no phase change, test passes → test_pass
    const emitted3 = runHook(
      hook,
      { turn: 3 },
      { name: 'test_runner', success: true, target: 'tests/unit' },
    )
    assert.ok(emitted3.some(msg => msg.includes('测试通过')), `expected test_pass, got: ${JSON.stringify(emitted3)}`)
  })

  it('emits stuck after 8 consecutive turns in the same phase class', () => {
    const hook = createRadioHook()

    // Turn 1: session_start
    runHook(hook, { turn: 1 })

    // Turns 2-8: no additional messages (stuck threshold not yet reached)
    for (let t = 2; t <= 8; t++) {
      const emitted = runHook(hook, { turn: t })
      const hasStuck = emitted.some(msg => msg.includes('可能遇到困难'))
      assert.equal(hasStuck, false, `expected no stuck on turn ${t}`)
    }

    // Turn 9: stuck detected (8 consecutive turns in 'explore')
    // Provide 8 entries in recentToolHistory to push count to 8.
    const toolHistory = Array.from({ length: 8 }, () => makeToolEntry('bash', 'echo hi'))
    const emitted9 = runHook(hook, { turn: 9, recentToolHistory: toolHistory })
    assert.ok(
      emitted9.some(msg => msg.includes('寻迹') && msg.includes('8')),
      `expected stuck message with 寻迹 and 8, got: ${JSON.stringify(emitted9)}`,
    )
  })
})
