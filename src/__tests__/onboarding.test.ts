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
import { onboardingText } from '../tui/onboarding.js'

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

  it('renders setup guidance with the dismiss command', () => {
    const text = onboardingText()

    assert.ok(text.includes('Welcome to Rivet'))
    assert.ok(text.includes('rivet config'))
    assert.ok(text.includes('rivet config setup deepseek'))
    assert.ok(text.includes('/onboarding dismiss'))
  })
})
