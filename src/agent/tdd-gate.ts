/**
 * TDD Gate
 *
 * Soft gate that injects a one-shot hint when the agent transitions from
 * planning to executing without having touched any test files.
 *
 * Consumed via the existing immune hint pipeline (_lastImmuneHint → formatImmuneContext),
 * so it does not pollute message history.
 */

import type { ImmuneContextHint } from './immune-context.js'
import type { DangerSignalKind } from './immune-types.js'

export interface TddGateInput {
  filesRead: Set<string>
  filesModified: Set<string>
  isActionable: boolean
}

const TEST_PATH_PATTERN = /(?:__tests__|\.test\.|\.spec\.|^test\/)/

function hasTestFile(paths: Set<string>): boolean {
  for (const p of paths) {
    if (TEST_PATH_PATTERN.test(p)) return true
  }
  return false
}

export function checkTddGate(input: TddGateInput): ImmuneContextHint | null {
  if (!input.isActionable) return null
  if (hasTestFile(input.filesRead) || hasTestFile(input.filesModified)) return null

  const hasNewSourceFiles = [...input.filesModified].some(f =>
    /\.tsx?$/.test(f) && !TEST_PATH_PATTERN.test(f)
  )

  const level = hasNewSourceFiles ? 'danger' : 'warning'

  return {
    level,
    signalKinds: ['tdd_violation' as DangerSignalKind],
    matchedMistakes: [],
    suggestion: `No test file touched yet. Write tests before implementation. Expected test path: src/**/__tests__/*.test.ts`,
  }
}
