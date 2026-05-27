/**
 * Verification Supersession Tests
 *
 * Tests the getEffectiveVerifications function that deduplicates
 * verification events by (command, scope) key, keeping only the
 * latest event per key. Later successes supersede earlier failures.
 */

import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { getEffectiveVerifications } from '../verification-attribution.js'
import type { TaskLedgerEvent } from '../task-ledger.js'

function makeVerificationEvent(
  command: string,
  status: 'passed' | 'failed' | 'blocked',
  scope: 'full' | 'targeted' = 'full',
  timestamp: number = Date.now(),
  metaOverrides: Record<string, unknown> = {},
): TaskLedgerEvent {
  return {
    type: 'verification',
    timestamp,
    command,
    status,
    meta: { scope, ...metaOverrides },
  }
}

describe('getEffectiveVerifications — deduplicate by (command, scope) key', () => {
  it('returns empty effective list for no verification events', () => {
    const events: TaskLedgerEvent[] = [
      { type: 'file_write', timestamp: Date.now(), path: 'src/a.ts' },
    ]
    const result = getEffectiveVerifications(events)
    assert.deepEqual(result.effective, [])
    assert.equal(result.supersededFailures, 0)
    assert.equal(result.totalRawCount, 0)
  })

  it('returns single verification as-is', () => {
    const events: TaskLedgerEvent[] = [
      makeVerificationEvent('npx tsc --noEmit', 'passed', 'full', 1000),
    ]
    const result = getEffectiveVerifications(events)
    assert.equal(result.effective.length, 1)
    assert.equal(result.effective[0]!.status, 'passed')
    assert.equal(result.effective[0]!.scope, 'full')
    assert.equal(result.supersededFailures, 0)
    assert.equal(result.totalRawCount, 1)
  })

  it('same targeted command failed → later passed: superseded, effective=pased', () => {
    const events: TaskLedgerEvent[] = [
      makeVerificationEvent('npx tsx --test foo.test.ts', 'failed', 'targeted', 1000),
      makeVerificationEvent('npx tsx --test foo.test.ts', 'passed', 'targeted', 2000),
    ]
    const result = getEffectiveVerifications(events)
    assert.equal(result.effective.length, 1)
    assert.equal(result.effective[0]!.status, 'passed')
    assert.equal(result.supersededFailures, 1)
    assert.equal(result.totalRawCount, 2)
  })

  it('full command failed → later full passed: superseded, effective=passed', () => {
    const events: TaskLedgerEvent[] = [
      makeVerificationEvent('npm test', 'failed', 'full', 1000),
      makeVerificationEvent('npm test', 'passed', 'full', 2000),
    ]
    const result = getEffectiveVerifications(events)
    assert.equal(result.effective.length, 1)
    assert.equal(result.effective[0]!.status, 'passed')
    assert.equal(result.supersededFailures, 1)
    assert.equal(result.totalRawCount, 2)
  })

  it('targeted failed → unrelated targeted passed: NOT superseded (different command)', () => {
    const events: TaskLedgerEvent[] = [
      makeVerificationEvent('npx tsx --test foo.test.ts', 'failed', 'targeted', 1000),
      makeVerificationEvent('npx tsx --test bar.test.ts', 'passed', 'targeted', 2000),
    ]
    const result = getEffectiveVerifications(events)
    assert.equal(result.effective.length, 2)
    // Both events remain — different command keys
    assert.equal(result.effective[0]!.command, 'npx tsx --test foo.test.ts')
    assert.equal(result.effective[0]!.status, 'failed')
    assert.equal(result.effective[1]!.command, 'npx tsx --test bar.test.ts')
    assert.equal(result.effective[1]!.status, 'passed')
    assert.equal(result.supersededFailures, 0)
    assert.equal(result.totalRawCount, 2)
  })

  it('targeted failed → full passed: NOT superseded (different scope key)', () => {
    const events: TaskLedgerEvent[] = [
      makeVerificationEvent('npm test', 'failed', 'targeted', 1000),
      makeVerificationEvent('npm test', 'passed', 'full', 2000),
    ]
    const result = getEffectiveVerifications(events)
    assert.equal(result.effective.length, 2)
    // Different scope → different key, both remain
    assert.equal(result.effective[0]!.scope, 'targeted')
    assert.equal(result.effective[0]!.status, 'failed')
    assert.equal(result.effective[1]!.scope, 'full')
    assert.equal(result.effective[1]!.status, 'passed')
    assert.equal(result.supersededFailures, 0)
    assert.equal(result.totalRawCount, 2)
  })

  it('full failed → later targeted passed: NOT superseded (different scope key)', () => {
    const events: TaskLedgerEvent[] = [
      makeVerificationEvent('npm test', 'failed', 'full', 1000),
      makeVerificationEvent('npm test', 'passed', 'targeted', 2000),
    ]
    const result = getEffectiveVerifications(events)
    assert.equal(result.effective.length, 2)
    assert.equal(result.supersededFailures, 0)
  })

  it('command normalization: whitespace differences are treated as same key', () => {
    const events: TaskLedgerEvent[] = [
      makeVerificationEvent('  npx   tsc --noEmit  ', 'failed', 'full', 1000),
      makeVerificationEvent('npx tsc --noEmit', 'passed', 'full', 2000),
    ]
    const result = getEffectiveVerifications(events)
    assert.equal(result.effective.length, 1)
    assert.equal(result.effective[0]!.status, 'passed')
    assert.equal(result.supersededFailures, 1)
  })

  it('multiple supersessions in a sequence', () => {
    const events: TaskLedgerEvent[] = [
      makeVerificationEvent('npm test', 'failed', 'full', 1000),
      makeVerificationEvent('npm test', 'failed', 'full', 2000),
      makeVerificationEvent('npm test', 'passed', 'full', 3000),
    ]
    const result = getEffectiveVerifications(events)
    assert.equal(result.effective.length, 1)
    assert.equal(result.effective[0]!.status, 'passed')
    // Only counts when a failed is replaced by a passed
    assert.equal(result.supersededFailures, 1)
    assert.equal(result.totalRawCount, 3)
  })

  it('non-verification events are filtered out', () => {
    const events: TaskLedgerEvent[] = [
      { type: 'file_write', timestamp: 1000, path: 'src/a.ts' },
      { type: 'file_read', timestamp: 1500, path: 'src/b.ts' },
      makeVerificationEvent('npm test', 'passed', 'full', 2000),
    ]
    const result = getEffectiveVerifications(events)
    assert.equal(result.effective.length, 1)
    assert.equal(result.totalRawCount, 1)
  })

  it('passed → later failed: NOT superseded (only failed→passed counts)', () => {
    const events: TaskLedgerEvent[] = [
      makeVerificationEvent('npm test', 'passed', 'full', 1000),
      makeVerificationEvent('npm test', 'failed', 'full', 2000),
    ]
    const result = getEffectiveVerifications(events)
    assert.equal(result.effective.length, 1)
    assert.equal(result.effective[0]!.status, 'failed')
    assert.equal(result.supersededFailures, 0)
  })

  it('multiple different commands with multiple supersessions', () => {
    const events: TaskLedgerEvent[] = [
      makeVerificationEvent('npx tsc --noEmit', 'failed', 'full', 1000),
      makeVerificationEvent('npm test', 'failed', 'full', 1500),
      makeVerificationEvent('npx tsc --noEmit', 'passed', 'full', 2000),
      makeVerificationEvent('npm test', 'passed', 'full', 2500),
    ]
    const result = getEffectiveVerifications(events)
    assert.equal(result.effective.length, 2)
    assert.equal(result.effective[0]!.command, 'npx tsc --noEmit')
    assert.equal(result.effective[0]!.status, 'passed')
    assert.equal(result.effective[1]!.command, 'npm test')
    assert.equal(result.effective[1]!.status, 'passed')
    assert.equal(result.supersededFailures, 2)
    assert.equal(result.totalRawCount, 4)
  })

  it('run_tests targeted failure is superseded by equivalent tsx --test success for same files', () => {
    const events: TaskLedgerEvent[] = [
      makeVerificationEvent(
        'run_tests src/agent/__tests__/scoped-git-commit.test.ts src/agent/__tests__/deliver-task.test.ts src/tools/__tests__/git.test.ts',
        'failed',
        'targeted',
        1000,
        { exitCode: 1, passed: 0, failed: 0, skipped: 0 },
      ),
      makeVerificationEvent(
        "./node_modules/.bin/tsx --test 'src/agent/__tests__/scoped-git-commit.test.ts' 'src/agent/__tests__/deliver-task.test.ts' 'src/tools/__tests__/git.test.ts'",
        'passed',
        'targeted',
        2000,
        { exitCode: 0, passed: 40, failed: 0, skipped: 0 },
      ),
    ]

    const result = getEffectiveVerifications(events)

    assert.equal(result.effective.length, 1)
    assert.equal(result.effective[0]!.status, 'passed')
    assert.equal(result.supersededFailures, 1)
  })

  it('npx tsx --test success supersedes run_tests failure for the same files', () => {
    const events: TaskLedgerEvent[] = [
      makeVerificationEvent(
        'run_tests src/agent/__tests__/deliver-task.test.ts src/tools/__tests__/git.test.ts',
        'failed',
        'targeted',
        1000,
        { exitCode: 1, passed: 0, failed: 0, skipped: 0 },
      ),
      makeVerificationEvent(
        'npx tsx --test src/tools/__tests__/git.test.ts src/agent/__tests__/deliver-task.test.ts',
        'passed',
        'targeted',
        2000,
        { exitCode: 0, passed: 22, failed: 0, skipped: 0 },
      ),
    ]

    const result = getEffectiveVerifications(events)

    assert.equal(result.effective.length, 1)
    assert.equal(result.effective[0]!.status, 'passed')
    assert.equal(result.supersededFailures, 1)
  })

  it('does not merge runner-family-equivalent commands when no test files can be extracted', () => {
    const events: TaskLedgerEvent[] = [
      makeVerificationEvent('run_tests', 'failed', 'targeted', 1000),
      makeVerificationEvent('npx tsx --test', 'passed', 'targeted', 2000),
    ]

    const result = getEffectiveVerifications(events)

    assert.equal(result.effective.length, 2)
    assert.equal(result.effective[0]!.command, 'run_tests')
    assert.equal(result.effective[0]!.status, 'failed')
    assert.equal(result.effective[1]!.command, 'npx tsx --test')
    assert.equal(result.effective[1]!.status, 'passed')
    assert.equal(result.supersededFailures, 0)
  })

  it('tool invocation failure metadata is preserved when parsed counts are all zero', () => {
    const events: TaskLedgerEvent[] = [
      makeVerificationEvent(
        'run_tests src/tools/__tests__/git.test.ts',
        'failed',
        'targeted',
        1000,
        { exitCode: 1, passed: 0, failed: 0, skipped: 0 },
      ),
    ]

    const result = getEffectiveVerifications(events)

    assert.equal(result.effective[0]!.failed, 0)
    assert.equal(result.effective[0]!.passed, 0)
    assert.equal(result.effective[0]!.failureKind, 'tool_invocation_failure')
  })
})
