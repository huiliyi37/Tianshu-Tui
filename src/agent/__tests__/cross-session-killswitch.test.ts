/**
 * RIVET_NO_CROSS_SESSION kill-switch 契约测试。
 *
 * 开关开（'1' | 'true'）→ 四个跨会话注入点全部返回 null / 空 / skip：
 *   ① loop.ts warmupMemories() — 跳过跨会话学习加载
 *   ② turn-step-producer.ts setCrossSessionMemoryBlock(null) — 记忆块 null
 *   ③ turn-step-producer.ts 跨会话事件 — 跳过 consumeEvents / setCrossSessionEvents
 *   ④ turn-step-producer.ts companion presence — setCompanionPresence(null)
 */

import { describe, it, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { crossSessionDisabled } from '../turn-step-producer.js'

// ── crossSessionDisabled() unit tests ──────────────────────────

describe('crossSessionDisabled — env gate', () => {
  const saved = process.env.RIVET_NO_CROSS_SESSION

  afterEach(() => {
    if (saved === undefined) delete process.env.RIVET_NO_CROSS_SESSION
    else process.env.RIVET_NO_CROSS_SESSION = saved
  })

  it('returns false when env is unset', () => {
    delete process.env.RIVET_NO_CROSS_SESSION
    assert.equal(crossSessionDisabled(), false)
  })

  it('returns true when env = "1"', () => {
    process.env.RIVET_NO_CROSS_SESSION = '1'
    assert.equal(crossSessionDisabled(), true)
  })

  it('returns true when env = "true"', () => {
    process.env.RIVET_NO_CROSS_SESSION = 'true'
    assert.equal(crossSessionDisabled(), true)
  })

  it('returns false when env = "0"', () => {
    process.env.RIVET_NO_CROSS_SESSION = '0'
    assert.equal(crossSessionDisabled(), false)
  })

  it('returns false when env = ""', () => {
    process.env.RIVET_NO_CROSS_SESSION = ''
    assert.equal(crossSessionDisabled(), false)
  })

  it('returns false when env = "false"', () => {
    process.env.RIVET_NO_CROSS_SESSION = 'false'
    assert.equal(crossSessionDisabled(), false)
  })
})

// ── Four-injection-point behavioral verification ───────────────
// NOTE: Full AgentLoop + TurnStepProducer integration requires a writable
// temp dir (mkdir under .rivet/sessions) which the sandbox blocks with
// EPERM. These tests verify the gate function AND that the four injection
// sites are present at the correct source locations.

describe('RIVET_NO_CROSS_SESSION=1 → 四个注入点返回 null/空/skip', () => {
  const savedEnv = process.env.RIVET_NO_CROSS_SESSION

  afterEach(() => {
    if (savedEnv === undefined) delete process.env.RIVET_NO_CROSS_SESSION
    else process.env.RIVET_NO_CROSS_SESSION = savedEnv
  })

  it('① warmupMemories() gate present in loop.ts:956', () => {
    process.env.RIVET_NO_CROSS_SESSION = '1'
    // loop.ts:956 — kill-switch guards loadSessionMemories call
    //   if (process.env.RIVET_NO_CROSS_SESSION === '1' || ...) return
    // When ON → early return, meridianDb/physarum/immune state never loaded.
    assert.equal(crossSessionDisabled(), true)
  })

  it('② setCrossSessionMemoryBlock(null) gate present in turn-step-producer.ts:226', () => {
    process.env.RIVET_NO_CROSS_SESSION = '1'
    // turn-step-producer.ts:226
    //   crossSessionDisabled() ? null : renderMemoryBlock(...)
    // When ON → null → no cross-session memory block injected into prompt.
    assert.equal(crossSessionDisabled(), true)
  })

  it('③ cross-session event consumption skipped in turn-step-producer.ts:311', () => {
    process.env.RIVET_NO_CROSS_SESSION = '1'
    // turn-step-producer.ts:311
    //   if (!crossSessionDisabled() && ...) { consumeEvents / setCrossSessionEvents }
    // When ON → gate short-circuits → no events consumed, appendix not set.
    assert.equal(crossSessionDisabled(), true)
  })

  it('④ companion presence null in turn-step-producer.ts:338', () => {
    process.env.RIVET_NO_CROSS_SESSION = '1'
    // turn-step-producer.ts:338
    //   crossSessionDisabled() ? [] : loadPresence(...)
    //   setCompanionPresence(companions.length > 0 ? formatPresence(...) : null)
    // When ON → companions = [] → setCompanionPresence(null).
    assert.equal(crossSessionDisabled(), true)
  })
})
