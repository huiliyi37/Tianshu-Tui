import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { TrajectoryRecorder } from '../trajectory.js'

describe('TrajectoryRecorder', () => {
  it('records entries and returns them', () => {
    const tr = new TrajectoryRecorder()
    tr.record({ turn: 1, tool: 'read_file', target: 'src/a.ts', durationMs: 50, status: 'success', inputSummary: 'path=src/a.ts', resultSummary: 'file content...' })
    assert.equal(tr.getEntries().length, 1)
    assert.equal(tr.getEntries()[0]!.tool, 'read_file')
  })

  it('summarizes stats correctly', () => {
    const tr = new TrajectoryRecorder()
    tr.record({ turn: 1, tool: 'read_file', target: 'a.ts', durationMs: 30, status: 'success', inputSummary: '', resultSummary: '' })
    tr.record({ turn: 1, tool: 'edit_file', target: 'b.ts', durationMs: 70, status: 'failed', errorClass: 'timeout', inputSummary: '', resultSummary: '' })
    tr.record({ turn: 2, tool: 'bash', target: 'npm test', durationMs: 200, status: 'retried-success', inputSummary: '', resultSummary: '' })
    const s = tr.summarize()
    assert.equal(s.totalTools, 3)
    assert.equal(s.failures, 1)
    assert.equal(s.retries, 1)
    assert.equal(s.avgDurationMs, 100)
  })

  it('exports as JSON string', () => {
    const tr = new TrajectoryRecorder()
    tr.record({ turn: 1, tool: 'grep', target: 'pattern', durationMs: 10, status: 'success', inputSummary: '', resultSummary: '' })
    const json = tr.exportJson()
    const parsed = JSON.parse(json)
    assert.equal(parsed.length, 1)
  })

  it('resets all entries', () => {
    const tr = new TrajectoryRecorder()
    tr.record({ turn: 1, tool: 'bash', target: 'ls', durationMs: 5, status: 'success', inputSummary: '', resultSummary: '' })
    tr.reset()
    assert.equal(tr.getEntries().length, 0)
  })
})
