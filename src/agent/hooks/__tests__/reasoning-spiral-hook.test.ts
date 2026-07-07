import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { createReasoningSpiralHook } from '../reasoning-spiral-hook.js'
import type { AdvisoryEntry } from '../../advisory-bus.js'
import type { RuntimeHookContext } from '../../runtime-hooks.js'

function makeCtx(opts: {
  turn: number
  lastThinkingLength?: number
  lastTurnHadTools?: boolean
}): RuntimeHookContext {
  return {
    snapshot: {
      cwd: '/fake',
      turn: opts.turn,
      recentToolHistory: [],
      sensorium: null,
      lastThinkingLength: opts.lastThinkingLength,
      lastTurnHadTools: opts.lastTurnHadTools,
    },
    effects: {},
  } as unknown as RuntimeHookContext
}

function collectAdvisories(): { submitted: AdvisoryEntry[]; hook: ReturnType<typeof createReasoningSpiralHook> } {
  const submitted: AdvisoryEntry[] = []
  const hook = createReasoningSpiralHook({
    advisoryBus: { submit: (e: AdvisoryEntry) => { submitted.push(e) } },
  })
  return { submitted, hook }
}

describe('reasoning-spiral-hook', () => {
  it('fires advisory on long thinking with no tools', () => {
    const { submitted, hook } = collectAdvisories()
    hook.run(makeCtx({ turn: 2, lastThinkingLength: 3500, lastTurnHadTools: false }))
    assert.equal(submitted.length, 1)
    assert.equal(submitted[0]!.key, 'reasoning-spiral')
    assert.match(submitted[0]!.content, /3\.5K/)
  })

  it('does NOT fire on short thinking', () => {
    const { submitted, hook } = collectAdvisories()
    hook.run(makeCtx({ turn: 2, lastThinkingLength: 500, lastTurnHadTools: false }))
    assert.equal(submitted.length, 0)
  })

  it('does NOT fire on long thinking WITH tool calls', () => {
    const { submitted, hook } = collectAdvisories()
    hook.run(makeCtx({ turn: 2, lastThinkingLength: 5000, lastTurnHadTools: true }))
    assert.equal(submitted.length, 0)
  })

  it('does NOT fire when fields are undefined', () => {
    const { submitted, hook } = collectAdvisories()
    hook.run(makeCtx({ turn: 2 }))
    assert.equal(submitted.length, 0)
  })

  it('cooldown: does not fire within 2 turns of last trigger', () => {
    const { submitted, hook } = collectAdvisories()
    hook.run(makeCtx({ turn: 2, lastThinkingLength: 3500, lastTurnHadTools: false }))
    assert.equal(submitted.length, 1)
    // turn 3 — within cooldown (2 - cooldown = need turn >= 4)
    hook.run(makeCtx({ turn: 3, lastThinkingLength: 4000, lastTurnHadTools: false }))
    assert.equal(submitted.length, 1) // still 1, cooldown
  })

  it('fires again after cooldown expires', () => {
    const { submitted, hook } = collectAdvisories()
    hook.run(makeCtx({ turn: 2, lastThinkingLength: 3500, lastTurnHadTools: false }))
    hook.run(makeCtx({ turn: 4, lastThinkingLength: 4000, lastTurnHadTools: false }))
    assert.equal(submitted.length, 2)
  })

  it('escalation: detects increasing trend across turns', () => {
    const { submitted, hook } = collectAdvisories()
    // turn 2: first long thinking
    hook.run(makeCtx({ turn: 2, lastThinkingLength: 3200, lastTurnHadTools: false }))
    assert.equal(submitted.length, 1)
    assert.ok(!submitted[0]!.content.includes('连续')) // first trigger is not escalation

    // turn 4: longer thinking, after cooldown
    hook.run(makeCtx({ turn: 4, lastThinkingLength: 4500, lastTurnHadTools: false }))
    assert.equal(submitted.length, 2)
    assert.ok(submitted[1]!.content.includes('连续')) // escalation wording
  })

  it('resets trend when a turn has tools', () => {
    const { submitted, hook } = collectAdvisories()
    hook.run(makeCtx({ turn: 2, lastThinkingLength: 3200, lastTurnHadTools: false }))
    // turn 3: has tools → resets trend
    hook.run(makeCtx({ turn: 3, lastThinkingLength: 3500, lastTurnHadTools: true }))
    // turn 4: long again but trend was reset → no escalation
    hook.run(makeCtx({ turn: 4, lastThinkingLength: 4000, lastTurnHadTools: false }))
    assert.equal(submitted.length, 2) // fired on turn 2 and turn 4
    assert.ok(!submitted[1]!.content.includes('连续')) // not escalation — trend was reset
  })

  it('formats length in K for large numbers', () => {
    const { submitted, hook } = collectAdvisories()
    hook.run(makeCtx({ turn: 2, lastThinkingLength: 8000, lastTurnHadTools: false }))
    assert.match(submitted[0]!.content, /8\.0K/)
  })
})
