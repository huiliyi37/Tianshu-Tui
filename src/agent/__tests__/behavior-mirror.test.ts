import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { detectMirror } from '../behavior-mirror.js'
import type { TrajectoryEntry } from '../trajectory.js'

describe('detectMirror', () => {
  it('detects repeated edits to same file', () => {
    const entries: TrajectoryEntry[] = [
      { turn: 1, tool: 'edit_file', target: 'src/auth.ts', durationMs: 50, status: 'success', inputSummary: '', resultSummary: '' },
      { turn: 2, tool: 'edit_file', target: 'src/auth.ts', durationMs: 50, status: 'success', inputSummary: '', resultSummary: '' },
      { turn: 3, tool: 'edit_file', target: 'src/auth.ts', durationMs: 50, status: 'success', inputSummary: '', resultSummary: '' },
    ]
    const mirror = detectMirror(entries)
    assert.ok(mirror)
    assert.ok(mirror.includes('auth.ts'))
    assert.ok(mirror.includes('3'))
  })

  it('detects repeated error class', () => {
    const entries: TrajectoryEntry[] = [
      { turn: 1, tool: 'bash', target: 'npm test', durationMs: 200, status: 'failed', errorClass: 'type_error', inputSummary: '', resultSummary: '' },
      { turn: 2, tool: 'bash', target: 'npm test', durationMs: 200, status: 'failed', errorClass: 'type_error', inputSummary: '', resultSummary: '' },
      { turn: 3, tool: 'bash', target: 'npm test', durationMs: 200, status: 'failed', errorClass: 'type_error', inputSummary: '', resultSummary: '' },
    ]
    const mirror = detectMirror(entries)
    assert.ok(mirror)
    assert.ok(mirror.includes('type_error'))
  })

  it('detects unverified edits', () => {
    const entries: TrajectoryEntry[] = [
      { turn: 1, tool: 'edit_file', target: 'a.ts', durationMs: 30, status: 'success', inputSummary: '', resultSummary: '' },
      { turn: 1, tool: 'edit_file', target: 'b.ts', durationMs: 30, status: 'success', inputSummary: '', resultSummary: '' },
      { turn: 2, tool: 'write_file', target: 'c.ts', durationMs: 30, status: 'success', inputSummary: '', resultSummary: '' },
    ]
    const mirror = detectMirror(entries)
    assert.ok(mirror)
    assert.ok(mirror.includes('3'))
    assert.ok(mirror.includes('test'))
  })

  it('returns null when no pattern detected', () => {
    const entries: TrajectoryEntry[] = [
      { turn: 1, tool: 'read_file', target: 'a.ts', durationMs: 10, status: 'success', inputSummary: '', resultSummary: '' },
      { turn: 1, tool: 'edit_file', target: 'a.ts', durationMs: 30, status: 'success', inputSummary: '', resultSummary: '' },
      { turn: 2, tool: 'bash', target: 'npm test', durationMs: 100, status: 'success', inputSummary: '', resultSummary: '' },
    ]
    assert.equal(detectMirror(entries), null)
  })

  it('returns null for fewer than 3 entries', () => {
    const entries: TrajectoryEntry[] = [
      { turn: 1, tool: 'edit_file', target: 'a.ts', durationMs: 30, status: 'success', inputSummary: '', resultSummary: '' },
    ]
    assert.equal(detectMirror(entries), null)
  })
})
