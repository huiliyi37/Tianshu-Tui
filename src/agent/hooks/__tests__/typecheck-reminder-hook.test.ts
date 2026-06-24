import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { createTypecheckReminderHook } from '../typecheck-reminder-hook.js'
import type { AdvisoryEntry } from '../../advisory-bus.js'
import type { RuntimeHookContext, RuntimeHookSnapshot } from '../../runtime-hooks.js'

function makeCtx(flags: Partial<RuntimeHookSnapshot>): RuntimeHookContext {
  return {
    snapshot: {
      cwd: '/test',
      turn: 3,
      recentToolHistory: [],
      sensorium: null,
      strategy: null,
      vigor: null,
      gitChangeRate: 0,
      season: null,
      ...flags,
    },
    effects: {
      setSensorium() {}, setStrategy() {}, setVigor() {},
      setGitChangeRate() {}, injectUserMessage() {},
      requestThetaCheck() {}, emitPhaseChange() {},
      emitDecisionShift() {}, markClaimStale() {},
    },
  }
}

function run(flags: Partial<RuntimeHookSnapshot>): AdvisoryEntry[] {
  const submitted: AdvisoryEntry[] = []
  const hook = createTypecheckReminderHook({ advisoryBus: { submit(e) { submitted.push(e) } } })
  hook.run(makeCtx(flags))
  return submitted
}

const RAN_TESTS = [{ tool: 'run_tests', status: 'success' as const, target: 'src/x.test.ts' }]

describe('TypecheckReminderHook', () => {
  it('fires: touched TS + ran tests + no typecheck', () => {
    const out = run({ touchedTsFiles: true, sawTypecheckThisTask: false, recentToolHistory: RAN_TESTS })
    assert.equal(out.length, 1)
    assert.equal(out[0]!.key, 'typecheck-reminder')
    assert.equal(out[0]!.tier, 'operational')
    assert.equal(out[0]!.category, 'typecheck')
    assert.equal(out[0]!.priority, 0.6)
  })

  it('point 4: fires even when the edit scrolled out of the window', () => {
    // recentToolHistory has no edit entry — only run_tests — but the task-level
    // flag remembers the TS edit.
    const out = run({ touchedTsFiles: true, sawTypecheckThisTask: false, recentToolHistory: RAN_TESTS })
    assert.equal(out.length, 1)
  })

  it('does not fire when a typecheck already ran', () => {
    const out = run({ touchedTsFiles: true, sawTypecheckThisTask: true, recentToolHistory: RAN_TESTS })
    assert.equal(out.length, 0)
  })

  it('does not fire when no TS file was touched', () => {
    const out = run({ touchedTsFiles: false, sawTypecheckThisTask: false, recentToolHistory: RAN_TESTS })
    assert.equal(out.length, 0)
  })

  it('does not fire when tests were not run', () => {
    const out = run({ touchedTsFiles: true, sawTypecheckThisTask: false, recentToolHistory: [] })
    assert.equal(out.length, 0)
  })

  it('does not crash on an empty snapshot', () => {
    const out = run({})
    assert.equal(out.length, 0)
  })
})
