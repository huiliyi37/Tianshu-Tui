/**
 * 召回健康账本契约测试（Wave 3 知识重构）。
 */
import { describe, it, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { createHash } from 'node:crypto'
import { memoryDir } from '../../config/paths.js'
import { RecallEfficacyTracker, readEfficacyLedger, getRecallTracker, releaseRecallTracker } from '../recall-efficacy.js'

describe('recall-efficacy', () => {
  let cwd: string

  beforeEach(() => {
    cwd = mkdtempSync(join(tmpdir(), 'rivet-efficacy-'))
    const hash = createHash('sha256').update(cwd).digest('hex').slice(0, 12)
    try { rmSync(memoryDir(hash), { recursive: true, force: true }) } catch {}
  })

  it('aggregates empty-rate and cite-rate into one ledger line per session', () => {
    const tracker = new RecallEfficacyTracker('sess-1')
    tracker.record('prefix cache', [{ text: 'Frozen prefix snapshots must stay byte-stable across turns' }])
    tracker.record('nonexistent thing', [])
    tracker.record('another miss', [])

    const record = tracker.finalize(cwd, 'As recalled: Frozen prefix snapshots must stay byte-stable across turns — applying it now.')

    assert.ok(record)
    assert.equal(record!.recalls, 3)
    assert.equal(record!.emptyRecalls, 2)
    assert.equal(record!.emptyRate, 0.67)
    assert.equal(record!.citedRecalls, 1)
    assert.equal(record!.citeRate, 1)

    const ledger = readEfficacyLedger(cwd)
    assert.equal(ledger.length, 1)
    assert.equal(ledger[0]!.sessionId, 'sess-1')
  })

  it('alerts after 3 consecutive high-empty sessions（链路静默失效检测）', () => {
    for (let i = 0; i < 3; i++) {
      const tracker = new RecallEfficacyTracker(`sess-${i}`)
      tracker.record('miss one', [])
      tracker.record('miss two', [])
      tracker.record('hit', [{ text: 'Some knowledge entry text long enough to be a snippet' }])
      tracker.finalize(cwd, '')
    }
    const ledger = readEfficacyLedger(cwd)
    assert.equal(ledger.length, 3)
    assert.equal(ledger[0]!.alert, false)
    assert.equal(ledger[1]!.alert, false)
    assert.equal(ledger[2]!.alert, true, 'third consecutive high-empty session must alert')
  })

  it('finalize returns null when no recalls happened', () => {
    const tracker = new RecallEfficacyTracker('sess-quiet')
    assert.equal(tracker.finalize(cwd, 'some text'), null)
    assert.equal(readEfficacyLedger(cwd).length, 0)
  })

  it('module registry hands out one tracker per session and releases it', () => {
    const a = getRecallTracker('sess-x')
    const b = getRecallTracker('sess-x')
    assert.equal(a, b)
    releaseRecallTracker('sess-x')
    const c = getRecallTracker('sess-x')
    assert.notEqual(a, c)
    releaseRecallTracker('sess-x')
  })
})
