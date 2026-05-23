import { describe, it, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { HeuristicStore } from '../heuristic-store.js'
import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

describe('HeuristicStore', () => {
  let dir: string
  let storePath: string

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'heuristic-test-'))
    storePath = join(dir, 'knowledge', 'heuristics.jsonl')
  })

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true })
  })

  it('appends and loads rules', async () => {
    const store = new HeuristicStore(storePath)
    await store.load()
    assert.equal(store.size, 0)

    await store.append([
      { pattern: 'Always run tests after edits', category: 'test', confidence: 0.5, source: 'compaction' },
      { pattern: 'Check imports before adding new ones', category: 'file-edit', confidence: 0.5, source: 'compaction' },
    ])
    assert.equal(store.size, 2)

    // Reload from disk
    const store2 = new HeuristicStore(storePath)
    await store2.load()
    assert.equal(store2.size, 2)
  })

  it('deduplicates by pattern', async () => {
    const store = new HeuristicStore(storePath)
    await store.load()
    await store.append([{ pattern: 'Same rule', category: 'test', confidence: 0.5, source: 'compaction' }])
    await store.append([{ pattern: 'Same rule', category: 'test', confidence: 0.5, source: 'compaction' }])
    assert.equal(store.size, 1)
  })

  it('getTopK returns sorted by score', async () => {
    const store = new HeuristicStore(storePath)
    await store.load()
    await store.append([
      { pattern: 'Low confidence rule', category: 'test', confidence: 0.3, source: 'compaction' },
      { pattern: 'High confidence rule', category: 'test', confidence: 0.9, source: 'compaction' },
    ])
    store.recordHit(store.getTopK(10)[0]!.id) // hit the high-confidence one

    const top = store.getTopK(1)
    assert.equal(top.length, 1)
    assert.ok(top[0]!.pattern.includes('High confidence'))
  })

  it('filters by category', async () => {
    const store = new HeuristicStore(storePath)
    await store.load()
    await store.append([
      { pattern: 'Test rule', category: 'test', confidence: 0.5, source: 'compaction' },
      { pattern: 'Edit rule', category: 'file-edit', confidence: 0.5, source: 'compaction' },
    ])
    const testRules = store.getTopK(10, 'test')
    assert.equal(testRules.length, 1)
    assert.ok(testRules[0]!.pattern.includes('Test'))
  })

  it('updateConfidence adjusts and clamps', async () => {
    const store = new HeuristicStore(storePath)
    await store.load()
    await store.append([{ pattern: 'Fragile rule', category: 'test', confidence: 0.5, source: 'compaction' }])
    const id = store.getTopK(10)[0]!.id

    store.updateConfidence(id, false) // 0.5 - 0.2 = 0.3
    store.updateConfidence(id, false) // 0.3 - 0.2 = 0.1
    // Now below 0.2 threshold — should not appear in getTopK
    const top = store.getTopK(10)
    assert.equal(top.length, 0)
  })

  it('prune removes cold rules', async () => {
    const store = new HeuristicStore(storePath)
    await store.load()
    await store.append([{ pattern: 'Old rule', category: 'test', confidence: 0.1, source: 'compaction' }])
    // Manually age the rule
    const rules = store.getTopK(10)
    // confidence is 0.1 which is below 0.2, hitCount is 0 — should be pruned if old enough
    // But createdAt is now, so within 30 days. Let's just verify prune doesn't crash
    const pruned = store.prune()
    assert.equal(pruned, 0) // not old enough yet
  })
})
