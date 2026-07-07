import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { createCourageHook } from '../hooks/courage-hook.js'
import { createSycophancyTrap } from '../sycophancy-trap.js'

describe('courage-hook constitutional override', () => {
  it('bypasses cooldown when sycophancy trap is active', () => {
    const trap = createSycophancyTrap()
    trap.recordTurn({ agreedWithUser: true, confidence: 0.7 })
    trap.recordTurn({ agreedWithUser: true, confidence: 0.6 })
    trap.recordTurn({ agreedWithUser: true, confidence: 0.5 })

    const messages: string[] = []
    const hook = createCourageHook({ cooldownTurns: 5, courageThreshold: 0.5, sycophancyTrap: trap })
    const makeCtx = (turn: number) => ({
      snapshot: { turn, recentToolHistory: [] },
      effects: { injectUserMessage: (msg: string) => { messages.push(msg) } },
    })

    hook.run(makeCtx(1) as any)
    hook.run(makeCtx(2) as any)

    assert.equal(messages.length, 2, `expected 2 triggers (bypass cooldown), got ${messages.length}`)
    for (const msg of messages) {
      assert.ok(msg.includes('必须'), `expected 必须 in ${msg}`)
      assert.ok(msg.includes('信念宪法'), `expected 信念宪法 tag in ${msg}`)
    }
  })

  it('emits risk message when only risk signals present, not constitutional', () => {
    const trap = createSycophancyTrap()
    trap.recordTurn({ agreedWithUser: true, confidence: 0.7 })
    trap.recordTurn({ agreedWithUser: true, confidence: 0.6 })

    const messages: string[] = []
    const hook = createCourageHook({ cooldownTurns: 1, courageThreshold: 0.3, sycophancyTrap: trap })
    hook.run({
      snapshot: { turn: 1, recentToolHistory: [{ tool: 'bash', status: 'failed' as const, target: 'tsc' }] },
      effects: { injectUserMessage: (msg: string) => { messages.push(msg) } },
    } as any)

    assert.equal(messages.length, 1)
    assert.ok(messages[0]!.includes('风险信号'), `expected 风险信号, got: ${messages[0]}`)
    assert.ok(!messages[0]!.includes('信念宪法'), 'risk message should not be constitutional')
  })

  it('does not trigger when no risk and trap inactive', () => {
    const trap = createSycophancyTrap()
    const messages: string[] = []
    const hook = createCourageHook({ cooldownTurns: 1, courageThreshold: 0.5, sycophancyTrap: trap })
    hook.run({
      snapshot: { turn: 1, recentToolHistory: [{ tool: 'bash', status: 'success' as const, target: 'npm test' }] },
      effects: { injectUserMessage: (msg: string) => { messages.push(msg) } },
    } as any)

    assert.equal(messages.length, 0)
  })

  it('constitutional message requires structural verification, bars dismissal', () => {
    const trap = createSycophancyTrap()
    trap.recordTurn({ agreedWithUser: true, confidence: 0.7 })
    trap.recordTurn({ agreedWithUser: true, confidence: 0.6 })
    trap.recordTurn({ agreedWithUser: true, confidence: 0.5 })

    const messages: string[] = []
    const hook = createCourageHook({ sycophancyTrap: trap })
    hook.run({
      snapshot: { turn: 1, recentToolHistory: [] },
      effects: { injectUserMessage: (msg: string) => { messages.push(msg) } },
    } as any)

    assert.equal(messages.length, 1)
    const msg = messages[0]!
    // Bars simple dismissal — message explicitly forbids these phrases
    assert.ok(!msg.includes('无阻塞风险'), 'constitutional must not allow no-risk dismissal')
    // Requires structural verification: file + lines + fact + impact
    assert.ok(msg.includes('文件'), 'must reference file path')
    assert.ok(msg.includes('行'), 'must reference line numbers')
    assert.ok(msg.includes('事实'), 'must reference specific facts')
    assert.ok(msg.includes('下一步'), 'must reference next-step impact')
    // Contains consequence for non-compliance
    assert.ok(msg.includes('方向暂停'), 'must specify consequence')
    // Forbids trivial fulfillment
    assert.ok(msg.includes('不可用'), 'must explicitly forbid trivial responses')
  })

  it('respects cooldown in regular (non-sycophancy) mode', () => {
    const trap = createSycophancyTrap()
    const messages: string[] = []
    const hook = createCourageHook({ cooldownTurns: 10, courageThreshold: 0.3, sycophancyTrap: trap })

    hook.run({
      snapshot: { turn: 1, recentToolHistory: [{ tool: 'bash', status: 'failed' as const, target: 'tsc' }] },
      effects: { injectUserMessage: (msg: string) => { messages.push(msg) } },
    } as any)
    assert.equal(messages.length, 1)

    hook.run({
      snapshot: { turn: 2, recentToolHistory: [{ tool: 'bash', status: 'failed' as const, target: 'tsc' }] },
      effects: { injectUserMessage: (msg: string) => { messages.push(msg) } },
    } as any)
    assert.equal(messages.length, 1, 'cooldown should block when trap inactive')
  })
})
