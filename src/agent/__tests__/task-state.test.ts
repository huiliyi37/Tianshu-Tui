import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { extractTaskState } from '../task-state.js'
import type { TrajectoryEntry } from '../trajectory.js'

describe('extractTaskState', () => {
  it('extracts completed steps from trajectory', () => {
    const entries: TrajectoryEntry[] = [
      { turn: 1, tool: 'read_file', target: 'src/auth.ts', durationMs: 30, status: 'success', inputSummary: '', resultSummary: '' },
      { turn: 1, tool: 'edit_file', target: 'src/auth.ts', durationMs: 50, status: 'success', inputSummary: '', resultSummary: '' },
      { turn: 2, tool: 'bash', target: 'npm test', durationMs: 200, status: 'failed', errorClass: 'assertion', inputSummary: '', resultSummary: '' },
    ]
    const state = extractTaskState(entries, '')
    assert.equal(state.completed.length, 2)
    assert.ok(state.completed[0]!.includes('read_file'))
    assert.ok(state.completed[1]!.includes('edit_file'))
    assert.ok(state.current.includes('fixing'))
  })

  it('extracts remaining from model text', () => {
    const entries: TrajectoryEntry[] = [
      { turn: 1, tool: 'read_file', target: 'a.ts', durationMs: 10, status: 'success', inputSummary: '', resultSummary: '' },
    ]
    const text = 'Next I need to edit the middleware and then run the tests.'
    const state = extractTaskState(entries, text)
    assert.ok(state.remaining.length > 0)
  })

  it('limits completed to last 5 entries', () => {
    const entries: TrajectoryEntry[] = Array.from({ length: 8 }, (_, i) => ({
      turn: 1, tool: 'read_file', target: `file${i}.ts`, durationMs: 10, status: 'success' as const, inputSummary: '', resultSummary: '',
    }))
    const state = extractTaskState(entries, '')
    assert.equal(state.completed.length, 5)
  })

  it('returns empty state for no entries', () => {
    const state = extractTaskState([], '')
    assert.equal(state.completed.length, 0)
    assert.equal(state.current, 'starting')
  })
})
