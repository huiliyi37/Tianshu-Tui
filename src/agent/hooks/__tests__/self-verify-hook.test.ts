import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { createSelfVerifyHook } from '../self-verify-hook.js'
import type { AdvisoryEntry } from '../../advisory-bus.js'
import type { RuntimeHookContext } from '../../runtime-hooks.js'

function makeCtx(tools: Array<{ tool: string; status: 'success' | 'failed' | 'running'; target: string }>): RuntimeHookContext {
  return {
    snapshot: {
      cwd: '/test',
      turn: 3,
      recentToolHistory: tools,
      sensorium: null,
      strategy: null,
      vigor: null,
      gitChangeRate: 0,
      season: null,
    },
    effects: {
      setSensorium() {}, setStrategy() {}, setVigor() {},
      setGitChangeRate() {}, injectUserMessage() {},
      requestThetaCheck() {}, emitPhaseChange() {},
      emitDecisionShift() {}, markClaimStale() {},
    },
  }
}

describe('SelfVerifyHook', () => {
  it('fires when all tools are read-class with no verification', () => {
    const submitted: AdvisoryEntry[] = []
    const hook = createSelfVerifyHook({
      advisoryBus: { submit(e: AdvisoryEntry) { submitted.push(e) } },
    })
    hook.run(makeCtx([
      { tool: 'read_file', status: 'success', target: 'src/a.ts' },
      { tool: 'grep', status: 'success', target: 'src/' },
      { tool: 'web_fetch', status: 'success', target: 'https://x.com' },
    ]))
    assert.equal(submitted.length, 1)
    assert.match(submitted[0]!.content, /没有独立验证/)
    assert.equal(submitted[0]!.category, 'discipline')
  })

  it('does NOT fire when a verify-class tool was used', () => {
    const submitted: AdvisoryEntry[] = []
    const hook = createSelfVerifyHook({
      advisoryBus: { submit(e: AdvisoryEntry) { submitted.push(e) } },
    })
    hook.run(makeCtx([
      { tool: 'read_file', status: 'success', target: 'src/a.ts' },
      { tool: 'run_tests', status: 'success', target: 'src/' },
    ]))
    assert.equal(submitted.length, 0)
  })

  it('does NOT fire when bash actually verifies (tsc/test/lint/build)', () => {
    const submitted: AdvisoryEntry[] = []
    const hook = createSelfVerifyHook({
      advisoryBus: { submit(e: AdvisoryEntry) { submitted.push(e) } },
    })
    hook.run(makeCtx([
      { tool: 'read_file', status: 'success', target: 'src/a.ts' },
      { tool: 'bash', status: 'success', target: 'tsc --noEmit' },
    ]))
    assert.equal(submitted.length, 0)
  })

  it('FIRES when bash is a non-verifying read (cat doc) — the core 看文档不验证 case', () => {
    const submitted: AdvisoryEntry[] = []
    const hook = createSelfVerifyHook({
      advisoryBus: { submit(e: AdvisoryEntry) { submitted.push(e) } },
    })
    hook.run(makeCtx([
      { tool: 'read_file', status: 'success', target: 'src/a.ts' },
      { tool: 'bash', status: 'success', target: 'cat docs/design.md' },
    ]))
    assert.equal(submitted.length, 1)
    assert.match(submitted[0]!.content, /没有独立验证/)
  })

  it('does NOT fire when no tools were used', () => {
    const submitted: AdvisoryEntry[] = []
    const hook = createSelfVerifyHook({
      advisoryBus: { submit(e: AdvisoryEntry) { submitted.push(e) } },
    })
    hook.run(makeCtx([]))
    assert.equal(submitted.length, 0)
  })

  it('fires when write tools used but no verify tools', () => {
    const submitted: AdvisoryEntry[] = []
    const hook = createSelfVerifyHook({
      advisoryBus: { submit(e: AdvisoryEntry) { submitted.push(e) } },
    })
    // edit_file is write-class but NOT verify-class
    hook.run(makeCtx([
      { tool: 'edit_file', status: 'success', target: 'src/a.ts' },
    ]))
    assert.equal(submitted.length, 1)
    assert.match(submitted[0]!.content, /没有独立验证/)
  })
})
