import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { appendSessionMemory, buildSessionMemoryBlock, loadSessionMemory } from '../session-memory.js'

describe('session memory', () => {
  it('appends and loads memory entries for a session', () => {
    const dir = mkdtempSync(join(tmpdir(), 'rivet-memory-'))
    try {
      const first = appendSessionMemory(dir, 's1', { text: 'User prefers design docs before implementation.', source: 'manual', createdAt: 1000 })
      const second = appendSessionMemory(dir, 's1', { text: 'Context engine design is saved.', source: 'compact', createdAt: 2000 })
      const loaded = loadSessionMemory(dir, 's1')

      assert.equal(first.entries.length, 1)
      assert.equal(second.entries.length, 2)
      assert.deepEqual(loaded.entries.map(entry => entry.text), [
        'User prefers design docs before implementation.',
        'Context engine design is saved.',
      ])
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('builds a stable XML memory block', () => {
    const block = buildSessionMemoryBlock({
      sessionId: 's2',
      entries: [{ id: 'm1', createdAt: 1000, text: 'Keep API rounds safe.', source: 'manual' }],
    })

    assert.match(block, /<session-memory/)
    assert.match(block, /source="manual"/)
    assert.match(block, /Keep API rounds safe\./)
  })

  it('returns empty string for empty memory', () => {
    const block = buildSessionMemoryBlock({ sessionId: 's3', entries: [] })
    assert.equal(block, '')
  })

  it('escapes XML special characters in entries', () => {
    const block = buildSessionMemoryBlock({
      sessionId: 's4',
      entries: [{ id: 'm2', createdAt: 1000, text: 'Use <style> tags & "quotes"', source: 'manual' }],
    })

    assert.match(block, /&lt;style&gt;/)
    assert.match(block, /&amp;/)
    assert.match(block, /&quot;/)
  })

  it('caps at 50 entries', () => {
    const dir = mkdtempSync(join(tmpdir(), 'rivet-memory-'))
    try {
      for (let i = 0; i < 55; i++) {
        appendSessionMemory(dir, 's5', { text: `Entry ${i}`, source: 'manual', createdAt: i * 1000 })
      }
      const loaded = loadSessionMemory(dir, 's5')
      assert.equal(loaded.entries.length, 50)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('deduplicates entries with the same text and source', () => {
    const dir = mkdtempSync(join(tmpdir(), 'rivet-memory-'))
    try {
      appendSessionMemory(dir, 's6', { text: 'Same compact memory.', source: 'compact', createdAt: 1000 })
      appendSessionMemory(dir, 's6', { text: 'Same compact memory.', source: 'compact', createdAt: 2000 })
      appendSessionMemory(dir, 's6', { text: 'Same compact memory.', source: 'manual', createdAt: 3000 })
      const loaded = loadSessionMemory(dir, 's6')
      assert.deepEqual(loaded.entries.map(entry => entry.source), ['compact', 'manual'])
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
