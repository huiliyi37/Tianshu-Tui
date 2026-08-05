import { describe, it, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ShadowQueue } from '../shadow-queue.js'

describe('ShadowQueue', () => {
  let dir: string

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'rivet-shadow-queue-'))
  })

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  it('enqueues predicted tool execution', () => {
    const queue = new ShadowQueue({
      execute: async () => 'result',
    })
    queue.enqueue({ tool: 'read_file', probability: 0.8, likelyTarget: 'src/foo.ts' })
    assert.equal(queue.pending(), 1)
  })

  it('returns cached result on hit when the target file is unchanged since enqueue', async () => {
    const target = join(dir, 'foo.ts')
    writeFileSync(target, 'export const a = 1\n')
    const queue = new ShadowQueue({
      execute: async () => 'cached-content',
    })
    queue.enqueue({ tool: 'read_file', probability: 0.8, likelyTarget: target })
    await new Promise(r => setTimeout(r, 20))
    const hit = queue.checkHit('read_file', target)
    assert.equal(hit, 'cached-content')
  })

  it('returns undefined on miss', () => {
    const queue = new ShadowQueue({ execute: async () => 'x' })
    assert.equal(queue.checkHit('read_file', join(dir, 'other.ts')), undefined)
  })

  it('does not enqueue below probability threshold', () => {
    const queue = new ShadowQueue({ execute: async () => 'x', minProbability: 0.5 })
    queue.enqueue({ tool: 'read_file', probability: 0.3, likelyTarget: 'src/foo.ts' })
    assert.equal(queue.pending(), 0)
  })

  it('does not speculate non-read-only tools', () => {
    const executed: string[] = []
    const queue = new ShadowQueue({
      execute: async (tool, target) => {
        executed.push(`${tool}:${target}`)
        return 'x'
      },
    })

    queue.enqueue({ tool: 'edit_file', probability: 0.9, likelyTarget: 'src/foo.ts' })

    assert.equal(queue.pending(), 0)
    assert.deepEqual(executed, [])
  })

  it('silently absorbs execution errors without unhandled rejection', async () => {
    let unhandledCount = 0
    const handler = () => { unhandledCount++ }
    process.on('unhandledRejection', handler)

    const queue = new ShadowQueue({
      execute: async () => { throw new Error('speculative failure') },
    })
    queue.enqueue({ tool: 'read_file', probability: 0.8, likelyTarget: 'src/foo.ts' })

    // Wait for the speculative execution to settle
    await new Promise(r => setTimeout(r, 50))

    // The result should NOT be cached (execution failed)
    const hit = queue.checkHit('read_file', 'src/foo.ts')
    assert.equal(hit, undefined)

    // inflight should be decremented even on failure
    assert.equal(queue.pending(), 0)

    // No unhandled rejection should have occurred
    assert.equal(unhandledCount, 0, 'speculative execution should not cause unhandled rejection')

    process.off('unhandledRejection', handler)
  })

  it('tracks per-source enqueue/hit stats', async () => {
    const a = join(dir, 'a.ts')
    const b = join(dir, 'b.ts')
    const c = join(dir, 'c.ts')
    writeFileSync(a, '1'); writeFileSync(b, '2'); writeFileSync(c, '3')
    const queue = new ShadowQueue({ execute: async () => 'content' })
    queue.enqueue({ tool: 'read_file', probability: 0.8, likelyTarget: a, source: 'llm' })
    queue.enqueue({ tool: 'read_file', probability: 0.8, likelyTarget: b, source: 'physarum-file' })
    queue.enqueue({ tool: 'read_file', probability: 0.8, likelyTarget: c }) // defaults to tool-pattern
    await new Promise(r => setTimeout(r, 20))

    queue.checkHit('read_file', a)

    const stats = queue.statsBySource()
    assert.equal(stats.llm.enqueued, 1)
    assert.equal(stats.llm.hits, 1)
    assert.equal(stats['physarum-file'].enqueued, 1)
    assert.equal(stats['physarum-file'].hits, 0)
    assert.equal(stats['tool-pattern'].enqueued, 1)
    assert.equal(stats['tool-pattern'].hits, 0)
  })

  it('enqueue returns void (fire-and-forget) — no floating promise returned', () => {
    const queue = new ShadowQueue({
      execute: async () => 'result',
    })
    // enqueue returns void, not Promise — caller cannot accidentally float it
    const result = queue.enqueue({ tool: 'read_file', probability: 0.8, likelyTarget: 'src/foo.ts' })
    assert.equal(result, undefined, 'enqueue must return void')
  })

  describe('staleness validation (2026-07-06 stale-read incident fix)', () => {
    it('rejects a hit when the target file was edited after enqueue (mtime/size moved)', async () => {
      const target = join(dir, 'edited.ts')
      writeFileSync(target, 'v1\n')
      const queue = new ShadowQueue({ execute: async () => 'stale content read at enqueue time' })
      queue.enqueue({ tool: 'read_file', probability: 0.8, likelyTarget: target })
      await new Promise(r => setTimeout(r, 20))

      // Simulate an edit landing between the speculative read and the real read.
      // Sleep a beat first: some filesystems have coarse mtime granularity and
      // an edit in the same tick could keep mtime identical — size still moves.
      await new Promise(r => setTimeout(r, 10))
      writeFileSync(target, 'v2 — much longer content than v1\n')

      const hit = queue.checkHit('read_file', target)
      assert.equal(hit, undefined, 'an edit after enqueue must invalidate the cached read, never serve stale content')
    })

    it('rejects a hit when the target was deleted after enqueue', async () => {
      const target = join(dir, 'deleted.ts')
      writeFileSync(target, 'v1\n')
      const queue = new ShadowQueue({ execute: async () => 'content' })
      queue.enqueue({ tool: 'read_file', probability: 0.8, likelyTarget: target })
      await new Promise(r => setTimeout(r, 20))

      rmSync(target)

      assert.equal(queue.checkHit('read_file', target), undefined)
    })

    it('rejects a hit when the target never existed (stat failed at enqueue time — cannot verify freshness)', async () => {
      const queue = new ShadowQueue({ execute: async () => 'content for a path that was never real' })
      const target = join(dir, 'never-existed.ts')
      queue.enqueue({ tool: 'read_file', probability: 0.8, likelyTarget: target })
      await new Promise(r => setTimeout(r, 20))

      assert.equal(queue.checkHit('read_file', target), undefined, 'unverifiable entries must never be served, not treated as fresh')
    })

    it('rejects a hit past the TTL even when the file is unchanged', async () => {
      const target = join(dir, 'aged-out.ts')
      writeFileSync(target, 'v1\n')
      const queue = new ShadowQueue({ execute: async () => 'content', ttlMs: 15 })
      queue.enqueue({ tool: 'read_file', probability: 0.8, likelyTarget: target })
      await new Promise(r => setTimeout(r, 40)) // enqueue settle (~20ms) + past the 15ms TTL

      assert.equal(queue.checkHit('read_file', target), undefined, 'TTL must expire an entry even if the underlying file never changed')
    })

    it('serves the hit when well within TTL and the file is unchanged', async () => {
      const target = join(dir, 'fresh.ts')
      writeFileSync(target, 'v1\n')
      const queue = new ShadowQueue({ execute: async () => 'content', ttlMs: 60_000 })
      queue.enqueue({ tool: 'read_file', probability: 0.8, likelyTarget: target })
      await new Promise(r => setTimeout(r, 20))

      assert.equal(queue.checkHit('read_file', target), 'content')
    })

    it('clear() empties the queue — the write/edit invalidation call site invokes this on any write success', async () => {
      const target = join(dir, 'foo.ts')
      writeFileSync(target, 'v1\n')
      const queue = new ShadowQueue({ execute: async () => 'content' })
      queue.enqueue({ tool: 'read_file', probability: 0.8, likelyTarget: target })
      await new Promise(r => setTimeout(r, 20))

      queue.clear()

      assert.equal(queue.checkHit('read_file', target), undefined, 'clear() must drop entries queued before any write')
    })
  })
})
