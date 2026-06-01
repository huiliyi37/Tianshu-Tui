import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { loadAllProjectMemoryEntries, loadProjectMemory } from '../project-memory-loader.js'

function writeMemory(cwd: string, entries: Array<Record<string, unknown> | string>): void {
  const dir = join(cwd, '.rivet', 'knowledge')
  mkdirSync(dir, { recursive: true })
  writeFileSync(
    join(dir, 'memory.jsonl'),
    entries.map(entry => typeof entry === 'string' ? entry : JSON.stringify(entry)).join('\n') + '\n',
    'utf-8',
  )
}

describe('project-memory-loader', () => {
  it('returns empty block when memory file is absent', () => {
    const dir = mkdtempSync(join(tmpdir(), 'rivet-memory-loader-'))
    try {
      assert.deepEqual(loadProjectMemory(dir), { content: '', entryCount: 0 })
      assert.deepEqual(loadAllProjectMemoryEntries(dir), [])
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('injects only Tier 1 high-confidence decisions, rules, and constraints', () => {
    const dir = mkdtempSync(join(tmpdir(), 'rivet-memory-loader-'))
    try {
      writeMemory(dir, [
        { id: 'decision-1', kind: 'decision', text: 'Use guided retrieval for memory.', confidence: 0.95, createdAt: 2, source: 'test' },
        { id: 'rule-1', kind: 'project_rule', text: 'Run typecheck before delivery.', confidence: 1, createdAt: 3, source: 'test' },
        { id: 'constraint-1', kind: 'user_constraint', text: 'Never expose secrets.', confidence: 0.9, createdAt: 4, source: 'test' },
        { id: 'weak-decision', kind: 'decision', text: 'Low confidence decision.', confidence: 0.89, createdAt: 5, source: 'test' },
        { id: 'file-1', kind: 'file_observation', text: 'Local implementation detail.', confidence: 1, createdAt: 6, source: 'test' },
      ])

      const block = loadProjectMemory(dir)

      assert.equal(block.entryCount, 3)
      assert.match(block.content, /Use guided retrieval/)
      assert.match(block.content, /Run typecheck/)
      assert.match(block.content, /Never expose secrets/)
      assert.doesNotMatch(block.content, /Low confidence/)
      assert.doesNotMatch(block.content, /Local implementation detail/)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('keeps commit facts recall-only even when they look Tier 1 eligible', () => {
    const dir = mkdtempSync(join(tmpdir(), 'rivet-memory-loader-'))
    try {
      writeMemory(dir, [
        { id: 'commit-1', kind: 'decision', text: 'Commit abc1234: "fix typo" (src/a.ts)', confidence: 0.95, createdAt: 2, source: 'test', tags: ['tool', 'commit_fact'] },
        { id: 'decision-1', kind: 'decision', text: 'Use guided retrieval for memory.', confidence: 0.95, createdAt: 1, source: 'test' },
      ])

      const block = loadProjectMemory(dir)
      const entries = loadAllProjectMemoryEntries(dir)

      assert.equal(block.entryCount, 1)
      assert.match(block.content, /Use guided retrieval/)
      assert.doesNotMatch(block.content, /Commit abc1234/)
      assert.ok(entries.some(e => e.id === 'commit-1'))
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('escapes XML-sensitive memory text in injected block', () => {
    const dir = mkdtempSync(join(tmpdir(), 'rivet-memory-loader-'))
    try {
      writeMemory(dir, [
        { id: 'decision-1', kind: 'decision', text: 'Use <xml> & "quotes" safely.', confidence: 0.95, createdAt: 1, source: 'test' },
      ])

      const block = loadProjectMemory(dir)

      assert.match(block.content, /&lt;xml&gt;/)
      assert.match(block.content, /&amp;/)
      assert.match(block.content, /&quot;quotes&quot;/)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('skips malformed JSONL lines and entries missing required fields', () => {
    const dir = mkdtempSync(join(tmpdir(), 'rivet-memory-loader-'))
    try {
      writeMemory(dir, [
        '{not json',
        { id: 'missing-text', kind: 'decision', confidence: 1, createdAt: 1, source: 'test' },
        { id: 'decision-1', kind: 'decision', text: 'Valid decision.', confidence: 0.95, createdAt: 2, source: 'test' },
      ])

      const entries = loadAllProjectMemoryEntries(dir)
      const block = loadProjectMemory(dir)

      assert.equal(entries.length, 1)
      assert.equal(entries[0]!.text, 'Valid decision.')
      assert.equal(block.entryCount, 1)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('returns Tier 1 and Tier 2 entries for recall sorted by confidence then recency', () => {
    const dir = mkdtempSync(join(tmpdir(), 'rivet-memory-loader-'))
    try {
      writeMemory(dir, [
        { id: 'older', kind: 'file_observation', text: 'Older same confidence.', confidence: 0.6, createdAt: 1, source: 'test' },
        { id: 'newer', kind: 'file_observation', text: 'Newer same confidence.', confidence: 0.6, createdAt: 2, source: 'test' },
        { id: 'strong', kind: 'decision', text: 'Highest confidence.', confidence: 0.95, createdAt: 0, source: 'test' },
      ])

      const entries = loadAllProjectMemoryEntries(dir)

      assert.deepEqual(entries.map(e => e.id), ['strong', 'newer', 'older'])
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('caps injected project memory to the render budget', () => {
    const dir = mkdtempSync(join(tmpdir(), 'rivet-memory-loader-'))
    try {
      writeMemory(dir, Array.from({ length: 80 }, (_, i) => ({
        id: `decision-${i}`,
        kind: 'decision',
        text: `Decision ${i} ${'x'.repeat(80)}`,
        confidence: 0.95,
        createdAt: i,
        source: 'test',
      })))

      const block = loadProjectMemory(dir)

      assert.ok(block.content.length <= 2100)
      assert.ok(block.entryCount < 80)
      assert.match(block.content, /^<project-memory entries="\d+">/)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
