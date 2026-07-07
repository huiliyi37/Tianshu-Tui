import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { createHash } from 'node:crypto'
import { SessionRegistry } from '../session-registry.js'
import {
  createCycleOpen,
  createCycleClose,
  taskSummaryToObligationDeposit,
} from '../songline.js'
import type { TaskLedgerSummary } from '../task-ledger.js'

function sha256(input: string): string {
  return createHash('sha256').update(input).digest('hex')
}

function makeSummary(overrides: Partial<TaskLedgerSummary> = {}): TaskLedgerSummary {
  return {
    taskId: 'task-123',
    eventCount: 4,
    readFileCount: 1,
    writeFileCount: 1,
    ownedFileCount: 1,
    verificationCount: 1,
    verificationStatus: 'verified',
    firstEventAt: 1000,
    lastEventAt: 2000,
    ...overrides,
  }
}

describe('songline substrate: cycle relay', () => {
  it('creates a deterministic first cycle_open when no previous close exists', () => {
    const first = createCycleOpen({ sessionId: 'session-a', prevCycleClose: null })
    const second = createCycleOpen({ sessionId: 'session-a', prevCycleClose: null })
    assert.equal(first, second)
    assert.equal(first.length, 64)
    assert.match(first, /^[0-9a-f]{64}$/)
  })

  it('inherits previous cycle_close as the next cycle_open', () => {
    const closeHash = sha256('session-a-close')
    assert.equal(
      createCycleOpen({ sessionId: 'session-b', prevCycleClose: closeHash }),
      closeHash,
    )
  })

  it('creates deterministic cycle_close from a task summary', () => {
    const summary = makeSummary()
    const first = createCycleClose(summary)
    const second = createCycleClose(summary)
    assert.equal(first, second)
    assert.equal(first.length, 64)
    assert.match(first, /^[0-9a-f]{64}$/)
  })

  it('persists cycle relay in SessionRegistry across registry instances', async () => {
    const dbDir = mkdtempSync(join(tmpdir(), 'songline-relay-test-'))
    let registry: SessionRegistry | null = null
    try {
      registry = await SessionRegistry.create(dbDir)
      const sessionA = 'session-a'
      const sessionB = 'session-b'
      const openA = createCycleOpen({ sessionId: sessionA, prevCycleClose: null })
      const closeA = createCycleClose(makeSummary({ taskId: 'task-a' }))

      registry.register(sessionA, '/project')
      registry.setCycleOpen(sessionA, openA)
      registry.setCycleClose(sessionA, closeA)
      registry.close()
      registry = null

      registry = await SessionRegistry.create(dbDir)
      assert.equal(registry.getCycleClose(sessionA), closeA)
      assert.equal(registry.getLastCycleClose(), closeA)

      const openB = createCycleOpen({ sessionId: sessionB, prevCycleClose: registry.getLastCycleClose() })
      registry.register(sessionB, '/project')
      registry.setCycleOpen(sessionB, openB)
      assert.equal(registry.getCycleOpen(sessionB), closeA)
    } finally {
      registry?.close()
      rmSync(dbDir, { recursive: true, force: true })
    }
  })
})

describe('songline substrate: obligation signal mapping', () => {
  it('maps a verified task summary to an obligation-fulfilled pheromone deposit', () => {
    const deposit = taskSummaryToObligationDeposit(makeSummary(), 'src/agent/task-ledger.ts')
    assert.equal(deposit.path, 'src/agent/task-ledger.ts')
    assert.equal(deposit.signal, 'obligation-fulfilled')
    assert.equal(deposit.strength, 1)
    assert.match(deposit.context ?? '', /task-123/)
    assert.match(deposit.context ?? '', /verified/)
  })

  it('uses bounded signal strength for unverified or failed summaries', () => {
    const unverified = taskSummaryToObligationDeposit(
      makeSummary({ verificationStatus: 'unverified', verificationCount: 0 }),
      'task://task-123',
    )
    const failed = taskSummaryToObligationDeposit(
      makeSummary({ verificationStatus: 'failed' }),
      'task://task-123',
    )

    assert.equal(unverified.signal, 'obligation-fulfilled')
    assert.ok(unverified.strength > 0 && unverified.strength < 1)
    assert.equal(failed.strength, 0.2)
  })
})
