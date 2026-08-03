import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  DECISIONS_HOLDOUT_RATE,
  DECISIONS_KEEP_THRESHOLD,
  DECISIONS_MIN_SAMPLE,
  decideDecisionsChannel,
  resolveDecisionsArm,
  type ArmRegressionRate,
} from '../decisions-experiment.js'

describe('decisions arm resolution', () => {
  it('defaults to off — an unmeasured channel does not ship silently', () => {
    assert.equal(resolveDecisionsArm('s1', undefined), 'off')
    assert.equal(resolveDecisionsArm('s1', ''), 'off')
    assert.equal(resolveDecisionsArm('s1', '0'), 'off')
  })

  it('forces treatment for deterministic runs', () => {
    assert.equal(resolveDecisionsArm('s1', '1'), 'treatment')
    assert.equal(resolveDecisionsArm(undefined, 'true'), 'treatment')
  })

  it('keeps a session in one arm for its whole life', () => {
    const first = resolveDecisionsArm('session-abc', 'experiment')
    for (let i = 0; i < 20; i++) {
      assert.equal(resolveDecisionsArm('session-abc', 'experiment'), first)
    }
  })

  it('falls back to off without a sessionId rather than polluting a denominator', () => {
    assert.equal(resolveDecisionsArm(undefined, 'experiment'), 'off')
  })

  it('splits near the declared holdout rate across many sessions', () => {
    const n = 20000
    let holdout = 0
    for (let i = 0; i < n; i++) {
      if (resolveDecisionsArm(`session-${i}`, 'experiment') === 'holdout') holdout++
    }
    const rate = holdout / n
    assert.ok(
      Math.abs(rate - DECISIONS_HOLDOUT_RATE) < 0.02,
      `holdout rate ${rate.toFixed(4)} should sit near ${DECISIONS_HOLDOUT_RATE}`,
    )
  })
})

describe('decisions channel verdict', () => {
  const arm = (over: Partial<ArmRegressionRate> = {}): ArmRegressionRate => ({
    sessions: 50,
    writes: 500,
    regressedWrites: 50,
    rate: 0.1,
    ...over,
  })

  it('returns null below the sample floor instead of guessing', () => {
    assert.equal(decideDecisionsChannel(arm({ sessions: DECISIONS_MIN_SAMPLE - 1 }), arm()), null)
    assert.equal(decideDecisionsChannel(arm(), arm({ sessions: DECISIONS_MIN_SAMPLE - 1 })), null)
  })

  it('keeps the channel only when the relative drop clears the pre-registered bar', () => {
    const holdout = arm({ rate: 0.2 })
    const justOver = decideDecisionsChannel(arm({ rate: 0.2 * (1 - DECISIONS_KEEP_THRESHOLD) - 0.001 }), holdout)
    assert.equal(justOver?.verdict, 'keep')

    const justUnder = decideDecisionsChannel(arm({ rate: 0.2 * (1 - DECISIONS_KEEP_THRESHOLD) + 0.001 }), holdout)
    assert.equal(justUnder?.verdict, 'drop')
  })

  it('drops the channel when treatment regresses more than control', () => {
    const verdict = decideDecisionsChannel(arm({ rate: 0.3 }), arm({ rate: 0.1 }))
    assert.equal(verdict?.verdict, 'drop')
    assert.ok(verdict!.relativeLift < 0)
  })

  it('drops the channel when the control never regressed — nothing to improve', () => {
    assert.deepEqual(decideDecisionsChannel(arm({ rate: 0 }), arm({ rate: 0 })), { verdict: 'drop', relativeLift: 0 })
  })
})
