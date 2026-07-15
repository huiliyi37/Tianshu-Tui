import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { loadAllProjectMemoryEntries, loadProjectMemory, queryProjectMemoryEntries } from '../project-memory-loader.js'

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

  it('injects only Tier 1 high-confidence rules and constraints (Wave 4 收紧)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'rivet-memory-loader-'))
    try {
      writeMemory(dir, [
        { id: 'rule-1', kind: 'project_rule', text: 'Run typecheck before delivery.', confidence: 1, createdAt: 3, source: 'test' },
        { id: 'constraint-1', kind: 'user_constraint', text: 'Never expose secrets.', confidence: 0.95, createdAt: 4, source: 'test' },
        { id: 'decision-1', kind: 'decision', text: 'Use guided retrieval for memory.', confidence: 0.95, createdAt: 2, source: 'test' },
        { id: 'fail-1', kind: 'failure_pattern', text: 'hash_edit regression after anchor replacement.', confidence: 0.95, createdAt: 7, source: 'test' },
        { id: 'weak-rule', kind: 'project_rule', text: 'Low confidence rule.', confidence: 0.9, createdAt: 5, source: 'test' },
        { id: 'file-1', kind: 'file_observation', text: 'Local implementation detail.', confidence: 1, createdAt: 6, source: 'test' },
      ])

      const block = loadProjectMemory(dir)

      assert.equal(block.entryCount, 2)
      assert.match(block.content, /Run typecheck/)
      assert.match(block.content, /Never expose secrets/)
      // Wave 4: decision / failure_pattern 转 recall-only，不进 Tier 1
      assert.doesNotMatch(block.content, /Use guided retrieval/)
      assert.doesNotMatch(block.content, /hash_edit regression/)
      // Wave 4: 置信门槛 0.9 → 0.95
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
        { id: 'commit-1', kind: 'project_rule', text: 'Commit abc1234: "fix typo" (src/a.ts)', confidence: 0.95, createdAt: 2, source: 'test', tags: ['tool', 'commit_fact'] },
        { id: 'rule-1', kind: 'project_rule', text: 'Use guided retrieval for memory.', confidence: 0.95, createdAt: 1, source: 'test' },
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
        { id: 'rule-1', kind: 'project_rule', text: 'Use <xml> & "quotes" safely.', confidence: 0.95, createdAt: 1, source: 'test' },
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
        { id: 'missing-text', kind: 'project_rule', confidence: 1, createdAt: 1, source: 'test' },
        { id: 'rule-1', kind: 'project_rule', text: 'Valid decision.', confidence: 0.95, createdAt: 2, source: 'test' },
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

  it('queryProjectMemoryEntries filters by query relevance and excludes commit facts', () => {
    const dir = mkdtempSync(join(tmpdir(), 'rivet-memory-loader-'))
    try {
      writeMemory(dir, [
        { id: 'rule-1', kind: 'project_rule', text: 'Sync to public repo via scripts/sync-to-public.sh only.', confidence: 1, createdAt: 1, source: 'test' },
        { id: 'rule-2', kind: 'project_rule', text: 'Node test runner is the only test framework.', confidence: 1, createdAt: 2, source: 'test' },
        { id: 'commit-1', kind: 'decision', text: 'Commit abc1234: sync public repo scripts', confidence: 0.95, createdAt: 3, source: 'test', tags: ['commit_fact'] },
        { id: 'unrelated', kind: 'decision', text: 'Desktop sidecar uses SSE transport.', confidence: 0.95, createdAt: 4, source: 'test' },
      ])

      const results = queryProjectMemoryEntries(dir, 'sync public repo')

      // Wave 1（知识重构）：recall 不再全量 dump——只回相关条目，commit_fact 走侧车
      assert.ok(results.some(e => e.id === 'rule-1'), 'relevant rule must be returned')
      assert.ok(!results.some(e => e.id === 'commit-1'), 'commit facts excluded from project memory query')
      assert.ok(!results.some(e => e.id === 'unrelated'), 'irrelevant entries filtered out')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('caps injected project memory to the render budget', () => {
    const dir = mkdtempSync(join(tmpdir(), 'rivet-memory-loader-'))
    try {
      writeMemory(dir, Array.from({ length: 80 }, (_, i) => ({
        id: `rule-${i}`,
        kind: 'project_rule',
        text: `Rule ${i} ${'x'.repeat(80)}`,
        confidence: 0.95,
        createdAt: i,
        source: 'test',
      })))

      const block = loadProjectMemory(dir)

      assert.ok(block.content.length <= 1600, 'Wave 4 budget: 1500 chars + envelope')
      assert.ok(block.entryCount < 80)
      assert.match(block.content, /^<project-memory entries="\d+">/)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
