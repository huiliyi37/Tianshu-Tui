import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  dismissOnboarding,
  getOnboardingState,
  onboardingSentinelPath,
  shouldHandleOnboardingInput,
} from '../onboarding.js'

function makeHome(): string {
  return mkdtempSync(join(tmpdir(), 'rivet-onboarding-'))
}

describe('onboarding state', () => {
  it('uses an explicit persisted sentinel path', () => {
    const home = makeHome()

    assert.equal(onboardingSentinelPath(home), join(home, '.rivet', 'onboarding-dismissed'))
    assert.equal(getOnboardingState(home).shouldShow, true)
  })

  it('persists dismissal and hides onboarding afterwards', () => {
    const home = makeHome()

    dismissOnboarding(home)

    assert.equal(getOnboardingState(home).shouldShow, false)
  })

  it('handles only explicit onboarding dismissal input', () => {
    assert.equal(shouldHandleOnboardingInput('/onboarding dismiss'), true)
    assert.equal(shouldHandleOnboardingInput('hello agent'), false)
    assert.equal(shouldHandleOnboardingInput('/help'), false)
  })
})
