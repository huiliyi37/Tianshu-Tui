import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'

export interface OnboardingState {
  shouldShow: boolean
}

export function onboardingSentinelPath(home = homedir()): string {
  return join(home, '.rivet', 'onboarding-dismissed')
}

export function getOnboardingState(home = homedir()): OnboardingState {
  return { shouldShow: !existsSync(onboardingSentinelPath(home)) }
}

export function dismissOnboarding(home = homedir()): void {
  const sentinel = onboardingSentinelPath(home)
  mkdirSync(join(home, '.rivet'), { recursive: true })
  writeFileSync(sentinel, 'dismissed\n')
}

export function shouldHandleOnboardingInput(input: string): boolean {
  return input.trim().toLowerCase() === '/onboarding dismiss'
}
