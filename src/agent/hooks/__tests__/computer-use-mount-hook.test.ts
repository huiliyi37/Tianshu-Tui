import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { createComputerUseMountHook, detectDesktopIntent } from '../computer-use-mount-hook.js'
import type { AdvisoryEntry } from '../../advisory-bus.js'
import type { RuntimeHookContext, RuntimeHookSnapshot } from '../../runtime-hooks.js'

function makeCtx(flags: Partial<RuntimeHookSnapshot>): RuntimeHookContext {
  return {
    snapshot: {
      cwd: '/test',
      turn: 0,
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

interface Harness {
  hook: ReturnType<typeof createComputerUseMountHook>
  submitted: AdvisoryEntry[]
  enableCalls: string[]
}

function makeHarness(intent: string | null, enableStatus = 'mounted'): Harness {
  const submitted: AdvisoryEntry[] = []
  const enableCalls: string[] = []
  const hook = createComputerUseMountHook({
    advisoryBus: { submit(e) { submitted.push(e) } },
    getUserIntent: () => intent,
    enableTool: name => {
      enableCalls.push(name)
      return { status: enableStatus }
    },
  })
  return { hook, submitted, enableCalls }
}

describe('detectDesktopIntent', () => {
  it('matches Chinese desktop GUI intents', () => {
    assert.equal(detectDesktopIntent('帮我打开系统设置改一下分辨率'), true)
    assert.equal(detectDesktopIntent('用微信发个消息'), true)
    assert.equal(detectDesktopIntent('点击访达里的下载文件夹'), true)
    assert.equal(detectDesktopIntent('桌面应用自动化测试'), true)
  })

  it('matches English desktop GUI intents', () => {
    assert.equal(detectDesktopIntent('automate the desktop app for me'), true)
    assert.equal(detectDesktopIntent('click the Save button in the app window'), true)
    assert.equal(detectDesktopIntent('use computer use to fill the form'), true)
  })

  it('does NOT match ordinary coding tasks', () => {
    assert.equal(detectDesktopIntent('修复 src/agent/loop.ts 的类型错误'), false)
    assert.equal(detectDesktopIntent('refactor the API client and add tests'), false)
    assert.equal(detectDesktopIntent('优化前端页面的加载速度'), false)
    assert.equal(detectDesktopIntent(null), false)
    assert.equal(detectDesktopIntent(''), false)
  })
})

describe('ComputerUseMountHook', () => {
  it('mounts computer_use on desktop intent at turn 0 and submits advisory', () => {
    const h = makeHarness('打开系统设置看看显示器配置')
    h.hook.run(makeCtx({ turn: 0 }))
    assert.deepEqual(h.enableCalls, ['computer_use'])
    assert.equal(h.submitted.length, 1)
    assert.equal(h.submitted[0]!.key, 'computer-use-mounted')
  })

  it('does not mount when intent is not desktop GUI', () => {
    const h = makeHarness('修复这个 TypeScript 编译错误')
    h.hook.run(makeCtx({ turn: 0 }))
    assert.equal(h.enableCalls.length, 0)
    assert.equal(h.submitted.length, 0)
  })

  it('never mounts after the early-turn window (prefix cache guard)', () => {
    const h = makeHarness('打开系统设置')
    h.hook.run(makeCtx({ turn: 5 }))
    assert.equal(h.enableCalls.length, 0)
    // 窗口过后永久停用——回到早期 turn 值也不再触发
    h.hook.run(makeCtx({ turn: 0 }))
    assert.equal(h.enableCalls.length, 0)
  })

  it('mounts at most once per session', () => {
    const h = makeHarness('打开系统设置')
    h.hook.run(makeCtx({ turn: 0 }))
    h.hook.run(makeCtx({ turn: 1 }))
    assert.equal(h.enableCalls.length, 1)
  })

  it('stays silent when the tool is not registered (unknown status)', () => {
    const h = makeHarness('打开系统设置', 'unknown')
    h.hook.run(makeCtx({ turn: 0 }))
    assert.equal(h.enableCalls.length, 1)
    assert.equal(h.submitted.length, 0)
  })

  it('stays silent when gating is off (tool already fully visible)', () => {
    const h = makeHarness('打开系统设置', 'gating-off')
    h.hook.run(makeCtx({ turn: 0 }))
    assert.equal(h.submitted.length, 0)
  })
})
