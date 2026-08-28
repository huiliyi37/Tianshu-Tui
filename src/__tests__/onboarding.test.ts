import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  dismissOnboarding,
  getOnboardingState,
  onboardingSentinelPath,
} from '../onboarding.js'

function makeHome(): string {
  return mkdtempSync(join(tmpdir(), 'rivet-onboarding-'))
}

describe('onboarding state', () => {
  it('uses an explicit persisted sentinel path（home 参数即 .rivet 根，RIVET_HOME 覆盖语义）', () => {
    const home = makeHome()

    assert.equal(onboardingSentinelPath(home), join(home, 'onboarding-dismissed'))
    assert.equal(getOnboardingState(home).shouldShow, true)
  })

  it('persists dismissal and hides onboarding afterwards', () => {
    const home = makeHome()

    dismissOnboarding(home)

    assert.equal(getOnboardingState(home).shouldShow, false)
  })
})
