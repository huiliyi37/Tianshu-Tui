import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { createRenderVerifyHook } from '../render-verify-hook.js'
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

function run(flags: Partial<RuntimeHookSnapshot>, deps?: { visualAvailable?: boolean; maxFires?: number }): AdvisoryEntry[] {
  const submitted: AdvisoryEntry[] = []
  const hook = createRenderVerifyHook({
    advisoryBus: { submit(e) { submitted.push(e) } },
    getVisualToolsAvailable: () => deps?.visualAvailable ?? true,
    maxFires: deps?.maxFires,
  })
  hook.run(makeCtx(flags))
  return submitted
}

describe('RenderVerifyHook', () => {
  it('fires: touched UI files + no visual verify', () => {
    const out = run({ touchedUiFiles: true, sawVisualVerify: false })
    assert.equal(out.length, 1)
    assert.equal(out[0]!.key, 'render-verify')
    assert.equal(out[0]!.tier, 'operational')
    assert.equal(out[0]!.category, 'discipline')
    assert.match(out[0]!.content, /browser.*截图|computer_use/)
  })

  it('does not fire when visual verification already happened', () => {
    const out = run({ touchedUiFiles: true, sawVisualVerify: true })
    assert.equal(out.length, 0)
  })

  it('does not fire when no UI file was touched', () => {
    const out = run({ touchedUiFiles: false, sawVisualVerify: false })
    assert.equal(out.length, 0)
  })

  it('does not fire when neither UI touched nor visual verified (baseline)', () => {
    const out = run({ touchedUiFiles: false, sawVisualVerify: false })
    assert.equal(out.length, 0)
  })

  it('fires only up to maxFires (default 2) across invocations', () => {
    const submitted: AdvisoryEntry[] = []
    const hook = createRenderVerifyHook({
      advisoryBus: { submit(e) { submitted.push(e) } },
      getVisualToolsAvailable: () => true,
    })
    const ctx = makeCtx({ touchedUiFiles: true, sawVisualVerify: false })
    for (let i = 0; i < 5; i++) hook.run(ctx)
    assert.equal(submitted.length, 2)
  })

  it('honors custom maxFires', () => {
    const submitted: AdvisoryEntry[] = []
    const hook = createRenderVerifyHook({
      advisoryBus: { submit(e) { submitted.push(e) } },
      maxFires: 1,
    })
    const ctx = makeCtx({ touchedUiFiles: true, sawVisualVerify: false })
    hook.run(ctx)
    hook.run(ctx)
    assert.equal(submitted.length, 1)
  })

  it('uses degraded advisory when visual tools unavailable', () => {
    const out = run({ touchedUiFiles: true, sawVisualVerify: false }, { visualAvailable: false })
    assert.equal(out.length, 1)
    assert.match(out[0]!.content, /缺少视觉验证工具[\s\S]*人工过目/)
    // 降级文案解释工具为何缺失（挂载条件），但不指示去调用它们
    assert.ok(!out[0]!.content.includes('open → navigate'))
  })

  it('defaults visual tools to available when callback is absent', () => {
    const submitted: AdvisoryEntry[] = []
    const hook = createRenderVerifyHook({
      advisoryBus: { submit(e) { submitted.push(e) } },
      // no getVisualToolsAvailable
    })
    hook.run(makeCtx({ touchedUiFiles: true, sawVisualVerify: false }))
    assert.equal(submitted.length, 1)
    assert.match(submitted[0]!.content, /browser/)
  })
})
