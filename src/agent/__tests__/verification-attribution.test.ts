import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { createVerificationAttribution } from '../verification-attribution.js'
import { createOwnershipLedger } from '../ownership-ledger.js'
import { createWorktreeBaseline, type BaselineSnapshot } from '../worktree-baseline.js'
import { createTaskLedger } from '../task-ledger.js'
import type { VerificationMetadata } from '../../tools/types.js'

function makeOwnership(ownedFiles: string[]) {
  const baseline = createWorktreeBaseline({
    branch: 'main',
    head: 'abc',
    preExistingDirty: [],
    preExistingUntracked: [],
    capturedAt: Date.now(),
  })
  const ledger = createTaskLedger({ taskId: 't1' })
  const ownership = createOwnershipLedger({ baseline, taskLedger: ledger })
  for (const f of ownedFiles) ownership.registerOwned(f)
  return ownership
}

function makeAttribution(ownedFiles: string[]) {
  return createVerificationAttribution({
    ownership: makeOwnership(ownedFiles),
  })
}

describe('verification-attribution — classify verification results by ownership', () => {
  it('classifies passed verification as verified', () => {
    const attr = makeAttribution(['src/tools/git.ts'])
    const result: VerificationMetadata = {
      command: 'npx tsc --noEmit',
      status: 'passed',
      scope: 'full',
      exitCode: 0,
      passed: 1,
      failed: 0,
      skipped: 0,
      durationMs: 100,
    }

    const a = attr.attribute(result)
    assert.equal(a.attribution, 'verified')
    assert.equal(a.isBlocking, false)
  })

  it('classifies failed targeted test on owned files as owned_failure', () => {
    const attr = makeAttribution(['src/tools/git.ts'])
    const result: VerificationMetadata = {
      command: 'npx tsx --test src/tools/__tests__/git.test.ts',
      status: 'failed',
      scope: 'targeted',
      exitCode: 1,
      passed: 5,
      failed: 1,
      skipped: 0,
      durationMs: 200,
    }

    const a = attr.attribute(result)
    assert.equal(a.attribution, 'owned_failure')
    assert.equal(a.isBlocking, true)
  })

  it('classifies failed full test as unattributed non-blocking caveat when ownership is unknown', () => {
    const attr = makeAttribution(['src/tools/git.ts'])
    const result: VerificationMetadata = {
      command: 'npm test',
      status: 'failed',
      scope: 'full',
      exitCode: 1,
      passed: 100,
      failed: 2,
      skipped: 0,
      durationMs: 5000,
    }

    const a = attr.attribute(result)
    assert.equal(a.attribution, 'unattributed_failure')
    assert.equal(a.isBlocking, false)
  })

  it('classifies blocked verification as external_blocked', () => {
    const attr = makeAttribution(['src/tools/git.ts'])
    const result: VerificationMetadata = {
      command: 'npx tsc --noEmit',
      status: 'blocked',
      scope: 'full',
      exitCode: 2,
      passed: 0,
      failed: 0,
      skipped: 0,
      durationMs: 50,
    }

    const a = attr.attribute(result)
    assert.equal(a.attribution, 'external_blocked')
    assert.equal(a.isBlocking, false)
  })

  it('getAggregateAttribution with all passing → verified', () => {
    const attr = makeAttribution(['src/a.ts'])
    const results: VerificationMetadata[] = [
      { command: 'typecheck', status: 'passed', scope: 'full', exitCode: 0, passed: 1, failed: 0, skipped: 0, durationMs: 100 },
      { command: 'tests', status: 'passed', scope: 'full', exitCode: 0, passed: 10, failed: 0, skipped: 0, durationMs: 500 },
    ]

    const agg = attr.getAggregateAttribution(results)
    assert.equal(agg.attribution, 'verified')
    assert.equal(agg.isBlocking, false)
  })

  it('getAggregateAttribution with owned failure → owned_failure', () => {
    const attr = makeAttribution(['src/a.ts'])
    const results: VerificationMetadata[] = [
      { command: 'typecheck', status: 'passed', scope: 'full', exitCode: 0, passed: 1, failed: 0, skipped: 0, durationMs: 100 },
      { command: 'tests', status: 'failed', scope: 'targeted', exitCode: 1, passed: 5, failed: 1, skipped: 0, durationMs: 300 },
    ]

    const agg = attr.getAggregateAttribution(results)
    assert.equal(agg.attribution, 'owned_failure')
    assert.equal(agg.isBlocking, true)
  })

  it('getAggregateAttribution with external blocked → external_blocked', () => {
    const attr = makeAttribution(['src/a.ts'])
    const results: VerificationMetadata[] = [
      { command: 'typecheck', status: 'blocked', scope: 'full', exitCode: 2, passed: 0, failed: 0, skipped: 0, durationMs: 50 },
      { command: 'tests', status: 'passed', scope: 'targeted', exitCode: 0, passed: 3, failed: 0, skipped: 0, durationMs: 200 },
    ]

    const agg = attr.getAggregateAttribution(results)
    assert.equal(agg.attribution, 'external_blocked')
    assert.equal(agg.isBlocking, false)
  })

  it('getAggregateAttribution: failed dominates blocked', () => {
    const attr = makeAttribution(['src/a.ts'])
    const results: VerificationMetadata[] = [
      { command: 'typecheck', status: 'blocked', scope: 'full', exitCode: 2, passed: 0, failed: 0, skipped: 0, durationMs: 50 },
      { command: 'tests', status: 'failed', scope: 'targeted', exitCode: 1, passed: 3, failed: 1, skipped: 0, durationMs: 200 },
    ]

    const agg = attr.getAggregateAttribution(results)
    assert.equal(agg.attribution, 'owned_failure')
    assert.equal(agg.isBlocking, true)
  })

  it('getAggregateAttribution with full-scope failed verification → unattributed_failure caveat', () => {
    const attr = makeAttribution(['src/a.ts'])
    const results: VerificationMetadata[] = [
      { command: 'typecheck', status: 'passed', scope: 'full', exitCode: 0, passed: 1, failed: 0, skipped: 0, durationMs: 100 },
      { command: 'tests', status: 'failed', scope: 'full', exitCode: 1, passed: 3, failed: 1, skipped: 0, durationMs: 200 },
    ]

    const agg = attr.getAggregateAttribution(results)
    assert.equal(agg.attribution, 'unattributed_failure')
    assert.equal(agg.isBlocking, false)
  })

  it('classifies verification invocation failure separately from owned test failure', () => {
    const attr = makeAttribution(['src/tools/git.ts'])
    const result: VerificationMetadata = {
      command: 'run_tests src/tools/__tests__/git.test.ts',
      status: 'failed',
      scope: 'targeted',
      exitCode: 1,
      passed: 0,
      failed: 0,
      skipped: 0,
      durationMs: 100,
      failureKind: 'tool_invocation_failure',
    }

    const a = attr.attribute(result)
    assert.equal(a.attribution, 'tool_invocation_failure')
    assert.equal(a.isBlocking, true)
    assert.match(a.reason, /verification invocation failed/i)
  })

  it('getAggregateAttribution with invocation failure does not report owned_failure', () => {
    const attr = makeAttribution(['src/a.ts'])
    const results: VerificationMetadata[] = [
      { command: 'typecheck', status: 'passed', scope: 'full', exitCode: 0, passed: 1, failed: 0, skipped: 0, durationMs: 100 },
      { command: 'run_tests src/a.test.ts', status: 'failed', scope: 'targeted', exitCode: 1, passed: 0, failed: 0, skipped: 0, durationMs: 100, failureKind: 'tool_invocation_failure' },
    ]

    const agg = attr.getAggregateAttribution(results)
    assert.equal(agg.attribution, 'tool_invocation_failure')
    assert.equal(agg.isBlocking, true)
  })

  it('empty verification list → unverified', () => {
    const attr = makeAttribution(['src/a.ts'])
    const agg = attr.getAggregateAttribution([])
    assert.equal(agg.attribution, 'unverified')
    assert.equal(agg.isBlocking, true)
  })
})
