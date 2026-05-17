import { describe, it, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import {
  StigmergyStore,
  computeCurrentStrength,
  type PheromoneDeposit,
  type Pheromone,
} from '../stigmergy.js'

// ─── computeCurrentStrength (pure decay) ────────────────────────────

describe('computeCurrentStrength', () => {
  it('returns full strength when just deposited (elapsed=0)', () => {
    assert.equal(computeCurrentStrength(1.0, 0, 604_800_000), 1.0)
  })

  it('returns ~0.5 after one half-life', () => {
    const halfLife = 3600_000 // 1 hour
    const result = computeCurrentStrength(1.0, halfLife, halfLife)
    assert.ok(Math.abs(result - 0.5) < 0.001, `expected ~0.5, got ${result}`)
  })

  it('returns ~0.25 after two half-lives', () => {
    const halfLife = 3600_000
    const result = computeCurrentStrength(1.0, halfLife * 2, halfLife)
    assert.ok(Math.abs(result - 0.25) < 0.001, `expected ~0.25, got ${result}`)
  })

  it('approaches zero for very old deposits', () => {
    const halfLife = 1000
    const result = computeCurrentStrength(1.0, halfLife * 10, halfLife)
    assert.ok(result < 0.01, `expected <0.01, got ${result}`)
  })

  it('scales by initial strength', () => {
    const halfLife = 3600_000
    const result = computeCurrentStrength(0.5, halfLife, halfLife)
    assert.ok(Math.abs(result - 0.25) < 0.001)
  })
})

// ─── StigmergyStore ─────────────────────────────────────────────────

describe('StigmergyStore', () => {
  let testDir: string
  let storePath: string

  beforeEach(() => {
    testDir = mkdtempSync(join(tmpdir(), 'stigmergy-test-'))
    storePath = join(testDir, 'pheromones.json')
  })

  afterEach(() => {
    try { rmSync(testDir, { recursive: true }) } catch { /* ignore */ }
  })

  it('load returns empty array for non-existent file', async () => {
    const store = new StigmergyStore(storePath)
    const entries = await store.load()
    assert.deepEqual(entries, [])
  })

  it('deposit adds a new pheromone', async () => {
    const store = new StigmergyStore(storePath)
    const deposit: PheromoneDeposit = {
      path: 'src/agent/sensorium.ts',
      signal: 'well-tested',
      strength: 0.6,
    }
    await store.deposit(deposit)
    const entries = await store.load()
    assert.equal(entries.length, 1)
    assert.equal(entries[0]!.path, 'src/agent/sensorium.ts')
    assert.equal(entries[0]!.signal, 'well-tested')
    assert.equal(entries[0]!.strength, 0.6)
    assert.ok(typeof entries[0]!.depositedAt === 'number')
    assert.equal(entries[0]!.halfLife, 604_800_000) // 7 days default
  })

  it('deposit includes optional context', async () => {
    const store = new StigmergyStore(storePath)
    await store.deposit({
      path: 'src/bug.ts',
      signal: 'fragile',
      strength: 0.8,
      context: 'fails on null input',
    })
    const entries = await store.load()
    assert.equal(entries[0]!.context, 'fails on null input')
  })

  it('persists across store instances (file persistence)', async () => {
    const store1 = new StigmergyStore(storePath)
    await store1.deposit({ path: 'a.ts', signal: 'entry-point', strength: 0.4 })
    await store1.deposit({ path: 'b.ts', signal: 'fragile', strength: 0.8 })

    const store2 = new StigmergyStore(storePath)
    const entries = await store2.load()
    assert.equal(entries.length, 2)
  })

  it('query returns entries matching path', async () => {
    const store = new StigmergyStore(storePath)
    await store.deposit({ path: 'a.ts', signal: 'well-tested', strength: 0.6 })
    await store.deposit({ path: 'b.ts', signal: 'fragile', strength: 0.8 })
    await store.deposit({ path: 'a.ts', signal: 'entry-point', strength: 0.4 })

    const results = await store.query('a.ts')
    assert.equal(results.length, 2)
    assert.ok(results.every(r => r.path === 'a.ts'))
  })

  it('query returns all entries when no path given', async () => {
    const store = new StigmergyStore(storePath)
    await store.deposit({ path: 'a.ts', signal: 'well-tested', strength: 0.6 })
    await store.deposit({ path: 'b.ts', signal: 'fragile', strength: 0.8 })

    const results = await store.query()
    assert.equal(results.length, 2)
  })

  it('query computes current strength with decay', async () => {
    const store = new StigmergyStore(storePath)
    // Deposit with a very short half-life so it decays quickly
    const now = Date.now()
    await store.deposit({ path: 'a.ts', signal: 'well-tested', strength: 1.0, halfLifeMs: 1000 })

    // Read back and check that currentStrength differs from original
    const results = await store.query('a.ts')
    assert.equal(results.length, 1)
    const entry = results[0]!
    assert.ok(entry.currentStrength !== undefined)
    assert.ok(entry.currentStrength <= entry.strength)
  })

  it('prune removes entries with currentStrength below threshold', async () => {
    const store = new StigmergyStore(storePath)

    // Fresh entry (strong)
    await store.deposit({ path: 'fresh.ts', signal: 'well-tested', strength: 0.9 })

    // Stale entry — deposit with past timestamp and short half-life
    const storePath2 = join(testDir, 'pheromones2.json')
    const store2 = new StigmergyStore(storePath2)
    const pastTimestamp = Date.now() - 10 * 24 * 3600_000 // 10 days ago
    const testEntry: Pheromone = {
      path: 'stale.ts',
      signal: 'dead-end',
      strength: 0.9,
      depositedAt: pastTimestamp,
      halfLife: 1000, // very short half-life → effectively zero now
    }
    // Manually insert for testing prune
    await store2.save([testEntry])

    const before = await store2.load()
    assert.equal(before.length, 1)

    await store2.prune()
    const after = await store2.load()
    assert.equal(after.length, 0) // stale entry removed
  })

  it('prune keeps entries above threshold', async () => {
    const store = new StigmergyStore(storePath)
    const freshEntry: Pheromone = {
      path: 'fresh.ts',
      signal: 'well-tested',
      strength: 0.9,
      depositedAt: Date.now(),
      halfLife: 604_800_000, // 7 days
    }
    await store.save([freshEntry])
    await store.prune()
    const after = await store.load()
    assert.equal(after.length, 1)
  })

  it('enforces max capacity (200) with LRU eviction', async () => {
    const store = new StigmergyStore(storePath, 10) // small cap for testing
    const now = Date.now()

    for (let i = 0; i < 15; i++) {
      await store.deposit({ path: `file-${i}.ts`, signal: 'entry-point', strength: 0.5 })
    }

    const entries = await store.load()
    assert.ok(entries.length <= 10)
    // Newest entries should be kept (LRU drops oldest)
    const paths = entries.map(e => e.path)
    assert.ok(paths.includes('file-14.ts'))
    assert.ok(!paths.includes('file-0.ts')) // oldest evicted
  })

  it('save and load round-trip preserves all fields', async () => {
    const store = new StigmergyStore(storePath)
    const now = Date.now()
    const entries: Pheromone[] = [
      { path: 'a.ts', signal: 'well-tested', strength: 0.6, depositedAt: now, halfLife: 604_800_000, context: 'good coverage' },
      { path: 'b.ts', signal: 'fragile', strength: 0.8, depositedAt: now - 1000, halfLife: 3600_000 },
    ]
    await store.save(entries)

    const loaded = await store.load()
    assert.equal(loaded.length, 2)
    assert.equal(loaded[0]!.path, 'a.ts')
    assert.equal(loaded[0]!.signal, 'well-tested')
    assert.equal(loaded[0]!.strength, 0.6)
    assert.equal(loaded[0]!.context, 'good coverage')
    assert.equal(loaded[1]!.signal, 'fragile')
  })

  it('handles corrupt file gracefully', async () => {
    // Write invalid JSON
    const { writeFileSync } = await import('node:fs')
    writeFileSync(storePath, '{invalid json!!!')
    const store = new StigmergyStore(storePath)
    const entries = await store.load()
    assert.deepEqual(entries, [])
  })

  it('deposit overwrites existing entry for same path+signal', async () => {
    const store = new StigmergyStore(storePath)
    await store.deposit({ path: 'a.ts', signal: 'fragile', strength: 0.5 })
    await store.deposit({ path: 'a.ts', signal: 'fragile', strength: 0.9 })

    const entries = await store.query('a.ts')
    const fragile = entries.filter(e => e.signal === 'fragile')
    assert.equal(fragile.length, 1)
    assert.equal(fragile[0]!.strength, 0.9)
  })
})
