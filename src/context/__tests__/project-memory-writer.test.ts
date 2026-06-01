import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { appendProjectMemory, compactProjectMemory } from '../project-memory-writer.js'

function claim(id: string, confidence: number, createdAt: number, text = `Claim ${id}`) {
  return {
    id,
    kind: 'decision',
    text,
    confidence,
    createdAt,
    evidence: [{ summary: `source ${id}` }],
  }
}

function memoryPath(cwd: string): string {
  return join(cwd, '.rivet', 'knowledge', 'memory.jsonl')
}

function readEntries(cwd: string): Array<Record<string, unknown>> {
  return readFileSync(memoryPath(cwd), 'utf-8')
    .split('\n')
    .filter(Boolean)
    .map(line => JSON.parse(line))
}

describe('project-memory-writer', () => {
  it('appends project memory entries to .rivet/knowledge/memory.jsonl', () => {
    const dir = mkdtempSync(join(tmpdir(), 'rivet-memory-writer-'))
    try {
      appendProjectMemory(dir, claim('decision-1', 0.95, 1, 'Use guided retrieval.'))

      assert.ok(existsSync(memoryPath(dir)))
      const entries = readEntries(dir)
      assert.equal(entries.length, 1)
      assert.equal(entries[0]!.id, 'decision-1')
      assert.equal(entries[0]!.text, 'Use guided retrieval.')
      assert.equal(entries[0]!.source, 'source decision-1')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('persists tags so commit facts can remain recall-only', () => {
    const dir = mkdtempSync(join(tmpdir(), 'rivet-memory-writer-'))
    try {
      appendProjectMemory(dir, {
        id: 'commit-1',
        kind: 'decision',
        text: 'Commit abc1234: "fix typo" (src/a.ts)',
        confidence: 0.95,
        createdAt: 1,
        tags: ['tool', 'commit_fact'],
      })

      const entries = readEntries(dir)
      assert.deepEqual(entries[0]!.tags, ['tool', 'commit_fact'])
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('uses unknown source when claim has no evidence summary', () => {
    const dir = mkdtempSync(join(tmpdir(), 'rivet-memory-writer-'))
    try {
      appendProjectMemory(dir, { id: 'decision-1', kind: 'decision', text: 'No source.', confidence: 0.9, createdAt: 1 })

      const entries = readEntries(dir)
      assert.equal(entries[0]!.source, 'unknown')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('returns zero when compacting an absent memory file', () => {
    const dir = mkdtempSync(join(tmpdir(), 'rivet-memory-writer-'))
    try {
      assert.equal(compactProjectMemory(dir), 0)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('deduplicates entries by id and keeps the latest duplicate', () => {
    const dir = mkdtempSync(join(tmpdir(), 'rivet-memory-writer-'))
    try {
      appendProjectMemory(dir, claim('same-id', 0.6, 1, 'Old text.'))
      appendProjectMemory(dir, claim('same-id', 0.95, 2, 'New text.'))

      const removed = compactProjectMemory(dir)
      const entries = readEntries(dir)

      assert.equal(removed, 1)
      assert.equal(entries.length, 1)
      assert.equal(entries[0]!.text, 'New text.')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('trims to the top 200 entries by confidence then recency', () => {
    const dir = mkdtempSync(join(tmpdir(), 'rivet-memory-writer-'))
    try {
      for (let i = 0; i < 205; i++) {
        appendProjectMemory(dir, claim(`claim-${i}`, i === 0 ? 0.1 : 0.9, i))
      }

      const removed = compactProjectMemory(dir)
      const entries = readEntries(dir)

      assert.equal(removed, 5)
      assert.equal(entries.length, 200)
      assert.ok(!entries.some(e => e.id === 'claim-0'))
      assert.equal(entries[0]!.id, 'claim-204')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('compacts oversized files even when entry count is below limit', () => {
    const dir = mkdtempSync(join(tmpdir(), 'rivet-memory-writer-'))
    const path = memoryPath(dir)
    try {
      mkdirSync(join(dir, '.rivet', 'knowledge'), { recursive: true })
      const lines = Array.from({ length: 20 }, (_, i) => JSON.stringify({
        id: `claim-${i}`,
        kind: 'decision',
        text: 'x'.repeat(1000),
        confidence: 0.9,
        createdAt: i,
        source: 'test',
      }))
      writeFileSync(path, lines.join('\n') + '\n', 'utf-8')

      const before = readFileSync(path, 'utf-8').length
      const removed = compactProjectMemory(dir)
      const after = readFileSync(path, 'utf-8').length

      assert.ok(before > 16_384)
      assert.equal(removed, 0)
      assert.ok(after <= before)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
