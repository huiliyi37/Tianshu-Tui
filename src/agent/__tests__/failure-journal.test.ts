import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { createFailureJournal } from '../failure-journal.js'

describe('failure journal — tianxuan correction #5', () => {
  it('records and retrieves entries', () => {
    const journal = createFailureJournal()
    journal.record({ turn: 1, tool: 'edit_file', error: 'syntax error', context: 'fix bug' })
    journal.record({ turn: 2, tool: 'bash', error: 'test failed', context: 'run tests' })
    assert.equal(journal.getEntries().length, 2)
  })

  it('detects anchoring pattern (same file 3+ times)', () => {
    const journal = createFailureJournal()
    // Use different contexts to avoid triggering rework
    journal.record({ turn: 1, tool: 'edit_file', target: 'src/foo.ts', error: 'e1', context: 'task A' })
    journal.record({ turn: 2, tool: 'edit_file', target: 'src/foo.ts', error: 'e2', context: 'task B' })
    journal.record({ turn: 3, tool: 'edit_file', target: 'src/foo.ts', error: 'e3', context: 'task C' })
    const patterns = journal.detectPatterns()
    const anchoring = patterns.filter(p => p.type === 'anchoring')
    assert.equal(anchoring.length, 1)
    assert.equal(anchoring[0]!.count, 3)
  })

  it('does not detect anchoring for different files', () => {
    const journal = createFailureJournal()
    // Use different contexts to avoid triggering rework
    journal.record({ turn: 1, tool: 'edit_file', target: 'src/a.ts', error: 'e1', context: 'task A' })
    journal.record({ turn: 2, tool: 'edit_file', target: 'src/b.ts', error: 'e2', context: 'task B' })
    journal.record({ turn: 3, tool: 'edit_file', target: 'src/c.ts', error: 'e3', context: 'task C' })
    const patterns = journal.detectPatterns()
    const anchoring = patterns.filter(p => p.type === 'anchoring')
    assert.equal(anchoring.length, 0)
  })

  it('detects rework pattern (same context 2+ times)', () => {
    const journal = createFailureJournal()
    journal.record({ turn: 1, tool: 'edit_file', error: 'e1', context: 'implement feature X' })
    journal.record({ turn: 5, tool: 'edit_file', error: 'e2', context: 'implement feature X' })
    const patterns = journal.detectPatterns()
    assert.ok(patterns.some(p => p.type === 'rework'))
  })

  it('getRecentEntries respects count', () => {
    const journal = createFailureJournal()
    for (let i = 0; i < 10; i++) {
      journal.record({ turn: i, tool: 'bash', error: `e${i}`, context: `task ${i}` })
    }
    assert.equal(journal.getRecentEntries(3).length, 3)
    assert.equal(journal.getRecentEntries(3)[0]!.turn, 7)
  })

  it('clear removes all entries', () => {
    const journal = createFailureJournal()
    journal.record({ turn: 1, tool: 'bash', error: 'e', context: 'c' })
    journal.clear()
    assert.equal(journal.getEntries().length, 0)
  })

  it('max entries cap', () => {
    const journal = createFailureJournal()
    for (let i = 0; i < 110; i++) {
      journal.record({ turn: i, tool: 'bash', error: `e${i}`, context: `task ${i}` })
    }
    assert.equal(journal.getEntries().length, 100)
    assert.equal(journal.getEntries()[0]!.turn, 10)
  })
})
