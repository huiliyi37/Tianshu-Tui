/**
 * Gate Ledger 契约测试（闭环 1 反馈回路）。
 *
 * 核心契约：
 * - 账本行落盘、FIFO cap、空路径容忍
 * - analyzeGateFeedback join 分析：admit 零召回率 / reject 复现检测
 * - renderGateFeedbackHint 只在阈值交叉时产出警告
 */
import { describe, it, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { createHash } from 'node:crypto'
import { memoryDir } from '../../config/paths.js'
import { writeGateLedgerRow, readGateLedger, analyzeGateFeedback, renderGateFeedbackHint, type GateLedgerRow } from '../gate-ledger.js'
import { RecallEfficacyTracker, getRecallTracker, releaseRecallTracker } from '../recall-efficacy.js'

function ledgerPath(cwd: string): string {
  const hash = createHash('sha256').update(cwd).digest('hex').slice(0, 12)
  return join(memoryDir(hash), 'gate-ledger.jsonl')
}

describe('gate-ledger', () => {
  let cwd: string

  beforeEach(() => {
    cwd = mkdtempSync(join(tmpdir(), 'rivet-gate-ledger-'))
  })

  it('writes one row per gate run and reads it back', () => {
    writeGateLedgerRow(cwd, {
      sessionId: 'sess-a',
      ts: Date.now(),
      admitted: [{ id: 'mem_1', textHash: 'abc123' }],
      rejected: [{ textHash: 'def456', snippet: 'noisy observation text' }],
      superseded: [],
      failedClosed: false,
    })

    assert.ok(existsSync(ledgerPath(cwd)))
    const rows = readGateLedger(cwd)
    assert.equal(rows.length, 1)
    assert.equal(rows[0]!.sessionId, 'sess-a')
    assert.equal(rows[0]!.admitted[0]!.id, 'mem_1')
    assert.equal(rows[0]!.rejected[0]!.textHash, 'def456')
  })

  it('tolerates missing ledger file (returns empty array)', () => {
    assert.deepEqual(readGateLedger(cwd), [])
    assert.deepEqual(readGateLedger(cwd, 5), [])
  })

  it('FIFO caps at MAX rows (50)', () => {
    for (let i = 0; i < 55; i++) {
      writeGateLedgerRow(cwd, {
        sessionId: `sess-${i}`,
        ts: Date.now(),
        admitted: [],
        rejected: [],
        superseded: [],
        failedClosed: false,
      })
    }
    const rows = readGateLedger(cwd, 100)
    assert.equal(rows.length, 50, 'should cap at 50 regardless of read limit')
    assert.equal(rows[0]!.sessionId, 'sess-5', 'oldest 5 should be dropped')
  })

  it('analyzeGateFeedback detects admit zero-recall (gate too permissive)', () => {
    // Gate admitted 2 entries
    writeGateLedgerRow(cwd, {
      sessionId: 's1', ts: Date.now(),
      admitted: [{ id: 'e1', textHash: 'h1' }, { id: 'e2', textHash: 'h2' }],
      rejected: [], superseded: [], failedClosed: false,
    })

    // Neither was ever recalled (empty efficacy ledger)
    // Need to create a session that was tracked but never recalled these IDs
    const fb = analyzeGateFeedback(cwd, 20)
    assert.equal(fb.totalAdmitted, 2)
    assert.equal(fb.neverRecalled, 2)
    assert.equal(fb.admitZeroRecallRate, 1, '100% admitted never recalled')
  })

  it('analyzeGateFeedback detects recalled entries (normal operation)', () => {
    // Gate admitted entry e1
    writeGateLedgerRow(cwd, {
      sessionId: 's1', ts: 1000,
      admitted: [{ id: 'e1', textHash: 'h1' }],
      rejected: [], superseded: [], failedClosed: false,
    })

    // Later session recalls e1
    const tracker = new RecallEfficacyTracker('s2')
    tracker.record('test query', [{ text: 'some recalled text', id: 'e1', gateAdmitted: true }])
    tracker.finalize(cwd, '')

    const fb = analyzeGateFeedback(cwd, 20)
    assert.equal(fb.totalAdmitted, 1)
    assert.equal(fb.neverRecalled, 0)
    assert.equal(fb.admitZeroRecallRate, 0, 'entry was recalled')
  })

  it('analyzeGateFeedback detects recurring rejects (gate too strict)', () => {
    const sameHash = 'noise123'
    // Two different gate runs reject the same textHash
    writeGateLedgerRow(cwd, {
      sessionId: 's1', ts: 1000,
      admitted: [], superseded: [],
      rejected: [{ textHash: sameHash, snippet: 'npx vitest is the test runner' }],
      failedClosed: false,
    })
    writeGateLedgerRow(cwd, {
      sessionId: 's2', ts: 2000,
      admitted: [], superseded: [],
      rejected: [{ textHash: sameHash, snippet: 'npx vitest is the test runner (again)' }],
      failedClosed: false,
    })

    const fb = analyzeGateFeedback(cwd, 20)
    assert.equal(fb.recurringRejectCount, 1, 'same material rejected ≥2 times across runs')
  })

  it('analyzeGateFeedback dedupes within same run (同一 run 同 hash 只计一次)', () => {
    // Gate rejects multiple candidates that normalize to same hash — dedup in runEssenceGate 已做，
    // 但账本行内有人为同 hash 重复时不应 double-count
    writeGateLedgerRow(cwd, {
      sessionId: 's1', ts: 1000,
      admitted: [], superseded: [],
      rejected: [
        { textHash: 'dup', snippet: 'a' },
        { textHash: 'dup', snippet: 'b' },
      ],
      failedClosed: false,
    })
    writeGateLedgerRow(cwd, {
      sessionId: 's2', ts: 2000,
      admitted: [], superseded: [],
      rejected: [{ textHash: 'dup', snippet: 'c' }],
      failedClosed: false,
    })

    const fb = analyzeGateFeedback(cwd, 20)
    assert.equal(fb.recurringRejectCount, 1, 'dup in same row should not inflate count')
  })

  it('renderGateFeedbackHint returns empty when thresholds not exceeded', () => {
    const hint = renderGateFeedbackHint(cwd, 20)
    assert.equal(hint, '')
  })

  it('renderGateFeedbackHint warns when admit zero-recall exceeds 0.5', () => {
    // 4 admitted, 0 recalled (0% recall) — should warn
    writeGateLedgerRow(cwd, {
      sessionId: 's1', ts: 1000,
      admitted: [
        { id: 'a1', textHash: 'h1' },
        { id: 'a2', textHash: 'h2' },
        { id: 'a3', textHash: 'h3' },
        { id: 'a4', textHash: 'h4' },
      ],
      rejected: [], superseded: [], failedClosed: false,
    })

    const hint = renderGateFeedbackHint(cwd, 20)
    assert.ok(hint.includes('zero-recall'), 'should warn about zero recall')
    assert.ok(hint.includes('Gate may be too permissive'), 'should include diagnostic')
  })

  it('renderGateFeedbackHint warns about recurring rejects', () => {
    const sameHash = 'r3j3ct'
    writeGateLedgerRow(cwd, {
      sessionId: 's1', ts: 1000, admitted: [], superseded: [],
      rejected: [{ textHash: sameHash, snippet: 'some noise' }],
      failedClosed: false,
    })
    writeGateLedgerRow(cwd, {
      sessionId: 's2', ts: 2000, admitted: [], superseded: [],
      rejected: [{ textHash: sameHash, snippet: 'same noise again' }],
      failedClosed: false,
    })

    const hint = renderGateFeedbackHint(cwd, 20)
    assert.ok(hint.includes('recurring reject'), 'should warn about recurring rejects')
    assert.ok(hint.includes('Gate may be too strict'), 'should include diagnostic')
  })

  it('renderGateFeedbackHint warns about failed-closed runs', () => {
    writeGateLedgerRow(cwd, {
      sessionId: 's1', ts: 1000,
      admitted: [], rejected: [], superseded: [],
      failedClosed: true,
    })

    const hint = renderGateFeedbackHint(cwd, 20)
    assert.ok(hint.includes('failed-closed'), 'should warn about LLM unavailability')
  })
})
