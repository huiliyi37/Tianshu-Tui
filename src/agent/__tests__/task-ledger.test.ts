import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { createTaskLedger, type TaskLedgerEvent } from '../task-ledger.js'

describe('task-ledger — task event recording and query', () => {
  const taskId = 'task-b1-scoped-commit'

  it('records and retrieves events in order', () => {
    const ledger = createTaskLedger({ taskId })

    ledger.record({ type: 'file_read', path: 'src/tools/git.ts' })
    ledger.record({ type: 'file_write', path: 'src/tools/git.ts' })
    ledger.record({ type: 'verification', command: 'npx tsc --noEmit', status: 'passed' })

    const events = ledger.getEvents()
    assert.equal(events.length, 3)
    assert.equal(events[0]!.type, 'file_read')
    assert.equal(events[1]!.type, 'file_write')
    assert.equal(events[2]!.type, 'verification')
  })

  it('derives owned files from write events, deduplicated', () => {
    const ledger = createTaskLedger({ taskId })

    ledger.record({ type: 'file_write', path: 'src/tools/git.ts' })
    ledger.record({ type: 'file_write', path: 'src/tools/diff.ts' })
    ledger.record({ type: 'file_write', path: 'src/tools/git.ts' }) // duplicate

    const owned = ledger.getOwnedFiles()
    assert.equal(owned.length, 2)
    assert.ok(owned.includes('src/tools/git.ts'))
    assert.ok(owned.includes('src/tools/diff.ts'))
  })

  it('derives verification status from verification events', () => {
    const ledger = createTaskLedger({ taskId })

    // No verifications + no writes → nothing needs verification
    assert.equal(ledger.getVerificationStatus(), 'verified')

    // With writes but no verifications → unverified
    ledger.record({ type: 'file_write', path: 'src/a.ts' })
    assert.equal(ledger.getVerificationStatus(), 'unverified')

    // Add a passing verification
    ledger.record({ type: 'verification', command: 'npx tsc --noEmit', status: 'passed' })
    assert.equal(ledger.getVerificationStatus(), 'verified')

    // Add a failing verification — failure should dominate
    ledger.record({ type: 'verification', command: 'npx tsx --test', status: 'failed' })
    assert.equal(ledger.getVerificationStatus(), 'failed')
  })

  it('blocked status overrides unverified but not failed', () => {
    const ledger = createTaskLedger({ taskId })

    ledger.record({ type: 'verification', command: 'typecheck', status: 'blocked' })
    assert.equal(ledger.getVerificationStatus(), 'blocked')

    // Failed still dominates blocked
    ledger.record({ type: 'verification', command: 'tests', status: 'failed' })
    assert.equal(ledger.getVerificationStatus(), 'failed')
  })

  it('getDeliveryReadiness returns structured readiness', () => {
    const ledger = createTaskLedger({ taskId })

    // No writes, no verifications
    const r1 = ledger.getDeliveryReadiness()
    assert.equal(r1.canDeliver, true)
    assert.equal(r1.level, 'verified')

    // Writes but no verification
    ledger.record({ type: 'file_write', path: 'src/tools/git.ts' })
    const r2 = ledger.getDeliveryReadiness()
    assert.equal(r2.canDeliver, false)
    assert.equal(r2.level, 'unverified')
    assert.ok(r2.reason!.includes('unverified'))

    // Writes + passing verification
    ledger.record({ type: 'verification', command: 'npx tsc --noEmit', status: 'passed' })
    const r3 = ledger.getDeliveryReadiness()
    assert.equal(r3.canDeliver, true)
    assert.equal(r3.level, 'verified')
  })

  it('getDeliveryReadiness returns external_blocked when verification is blocked', () => {
    const ledger = createTaskLedger({ taskId })
    ledger.record({ type: 'file_write', path: 'src/tools/git.ts' })
    ledger.record({ type: 'verification', command: 'typecheck', status: 'blocked' })

    const r = ledger.getDeliveryReadiness()
    assert.equal(r.canDeliver, true) // can deliver with caveat
    assert.equal(r.level, 'external_blocked')
    assert.ok(r.reason!.includes('blocked'))
  })

  it('getDeliveryReadiness returns failed when verification fails', () => {
    const ledger = createTaskLedger({ taskId })
    ledger.record({ type: 'file_write', path: 'src/tools/git.ts' })
    ledger.record({ type: 'verification', command: 'tests', status: 'failed' })

    const r = ledger.getDeliveryReadiness()
    assert.equal(r.canDeliver, false)
    assert.equal(r.level, 'failed')
  })

  it('getSummary returns structured summary for stigmergy/songline deposit', () => {
    const ledger = createTaskLedger({ taskId })
    ledger.record({ type: 'file_read', path: 'src/tools/git.ts' })
    ledger.record({ type: 'file_write', path: 'src/tools/git.ts' })
    ledger.record({ type: 'file_write', path: 'src/tools/diff.ts' })
    ledger.record({ type: 'verification', command: 'npx tsc --noEmit', status: 'passed' })

    const summary = ledger.getSummary()
    assert.equal(summary.taskId, taskId)
    assert.equal(summary.eventCount, 4)
    assert.equal(summary.ownedFileCount, 2)
    assert.equal(summary.verificationStatus, 'verified')
    assert.equal(summary.readFileCount, 1)
    assert.equal(summary.writeFileCount, 2)
    assert.equal(summary.verificationCount, 1)
  })

  it('supports multiple verification events with mixed status', () => {
    const ledger = createTaskLedger({ taskId })
    ledger.record({ type: 'verification', command: 'typecheck', status: 'passed' })
    ledger.record({ type: 'verification', command: 'unit tests', status: 'passed' })
    ledger.record({ type: 'verification', command: 'lint', status: 'blocked' })

    const v = ledger.getVerifications()
    assert.equal(v.length, 3)
    assert.equal(ledger.getVerificationStatus(), 'blocked')
  })

  it('taskId is exposed', () => {
    const ledger = createTaskLedger({ taskId: 'b1-ownership' })
    assert.equal(ledger.getTaskId(), 'b1-ownership')
  })

  it('reset clears all state', () => {
    const ledger = createTaskLedger({ taskId })
    ledger.record({ type: 'file_write', path: 'a.ts' })
    ledger.record({ type: 'verification', command: 't', status: 'passed' })

    ledger.reset()

    assert.equal(ledger.getEvents().length, 0)
    assert.equal(ledger.getOwnedFiles().length, 0)
    assert.equal(ledger.getVerificationStatus(), 'verified')
    assert.equal(ledger.getVerifications().length, 0)
  })
})
