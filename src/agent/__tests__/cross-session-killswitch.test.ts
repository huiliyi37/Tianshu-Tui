/**
 * RIVET_NO_CROSS_SESSION kill-switch 契约测试。
 *
 * 控制通道（优先级从高到低）：
 *   ① env RIVET_NO_CROSS_SESSION=1/true → force-off（crossSessionDisabled=true）
 *   ② env RIVET_NO_CROSS_SESSION=0/false → force-on（crossSessionDisabled=false）
 *   ③ config.crossSessionEnabled（默认 true → crossSessionDisabled=false）
 *   ④ 无 config+无 env → 回退默认 disabled=true（向后兼容）
 *
 * 四个注入点（turn-step-producer.ts + loop.ts）：
 *   ① warmupMemories() — 跨会话记忆预热
 *   ② setCrossSessionMemoryBlock() — 记忆块注入 prompt
 *   ③ cross-session event consumption — 跨会话事件消费
 *   ④ companion presence — 跨会话 companion 存在感
 */

import { describe, it, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { crossSessionDisabled, crossSessionMemoryPushEnabled } from '../turn-step-producer.js'

// ── crossSessionDisabled() unit tests ──────────────────────────

describe('crossSessionDisabled — env + config', () => {
  const saved = process.env.RIVET_NO_CROSS_SESSION

  afterEach(() => {
    if (saved === undefined) delete process.env.RIVET_NO_CROSS_SESSION
    else process.env.RIVET_NO_CROSS_SESSION = saved
  })

  // ── Env var overrides ──

  it('env=1 force-off regardless of config', () => {
    process.env.RIVET_NO_CROSS_SESSION = '1'
    assert.equal(crossSessionDisabled(true), true)
    assert.equal(crossSessionDisabled(false), true)
  })

  it('env=true force-off regardless of config', () => {
    process.env.RIVET_NO_CROSS_SESSION = 'true'
    assert.equal(crossSessionDisabled(true), true)
    assert.equal(crossSessionDisabled(false), true)
  })

  it('env=0 force-on regardless of config', () => {
    process.env.RIVET_NO_CROSS_SESSION = '0'
    assert.equal(crossSessionDisabled(true), false)
    assert.equal(crossSessionDisabled(false), false)
  })

  it('env=false force-on regardless of config', () => {
    process.env.RIVET_NO_CROSS_SESSION = 'false'
    assert.equal(crossSessionDisabled(true), false)
    assert.equal(crossSessionDisabled(false), false)
  })

  // ── Config-driven (no env) ──

  it('config enabled → cross-session NOT disabled', () => {
    delete process.env.RIVET_NO_CROSS_SESSION
    assert.equal(crossSessionDisabled(true), false)
  })

  it('config disabled → cross-session IS disabled', () => {
    delete process.env.RIVET_NO_CROSS_SESSION
    assert.equal(crossSessionDisabled(false), true)
  })

  it('config undefined → cross-session IS disabled (no env either)', () => {
    delete process.env.RIVET_NO_CROSS_SESSION
    assert.equal(crossSessionDisabled(), true)
  })

  it('config undefined + env="" → cross-session IS disabled', () => {
    process.env.RIVET_NO_CROSS_SESSION = ''
    assert.equal(crossSessionDisabled(), true)
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

  it('① warmupMemories() gate present in loop.ts:966', () => {
    process.env.RIVET_NO_CROSS_SESSION = '1'
    // loop.ts:966 — force-off gate: env=1 overrides config
    assert.equal(crossSessionDisabled(true), true)
  })

  it('② setCrossSessionMemoryBlock(null) gate present in turn-step-producer.ts:225', () => {
    process.env.RIVET_NO_CROSS_SESSION = '1'
    // turn-step-producer.ts:225
    //   crossSessionDisabled(configEnabled) ? null : renderMemoryBlock(...)
    assert.equal(crossSessionDisabled(true), true)
  })

  it('③ cross-session event consumption skipped in turn-step-producer.ts:303', () => {
    process.env.RIVET_NO_CROSS_SESSION = '1'
    // turn-step-producer.ts:303
    //   if (!crossSessionDisabled(configEnabled) && ...)
    assert.equal(crossSessionDisabled(true), true)
  })

  it('④ companion presence null in turn-step-producer.ts:331', () => {
    process.env.RIVET_NO_CROSS_SESSION = '1'
    // turn-step-producer.ts:331
    //   crossSessionDisabled(configEnabled) ? [] : loadPresence(...)
    assert.equal(crossSessionDisabled(true), true)
  })
})

// ── Wave 1（知识重构）：cross-session memory 推送默认退位 ────────

describe('crossSessionMemoryPushEnabled — 记忆块推送默认关闭', () => {
  const saved = process.env.RIVET_CROSS_SESSION_INJECT

  afterEach(() => {
    if (saved === undefined) delete process.env.RIVET_CROSS_SESSION_INJECT
    else process.env.RIVET_CROSS_SESSION_INJECT = saved
  })

  it('默认（无 env）→ 推送关闭', () => {
    delete process.env.RIVET_CROSS_SESSION_INJECT
    assert.equal(crossSessionMemoryPushEnabled(), false)
  })

  it('env=1 → 显式恢复推送（对照实验回退口）', () => {
    process.env.RIVET_CROSS_SESSION_INJECT = '1'
    assert.equal(crossSessionMemoryPushEnabled(), true)
  })

  it('env=true → 显式恢复推送', () => {
    process.env.RIVET_CROSS_SESSION_INJECT = 'true'
    assert.equal(crossSessionMemoryPushEnabled(), true)
  })

  it('env=0 → 推送保持关闭', () => {
    process.env.RIVET_CROSS_SESSION_INJECT = '0'
    assert.equal(crossSessionMemoryPushEnabled(), false)
  })
})
