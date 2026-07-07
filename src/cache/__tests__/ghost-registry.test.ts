import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { GhostRegistry } from '../ghost-registry.js'

describe('GhostRegistry', () => {
  it('records eviction and tracks access', () => {
    const registry = new GhostRegistry()
    registry.record({ artifactId: 'a1', tool: 'read_file', target: 'src/foo.ts', evictedAtTurn: 5, originalTokens: 200 })
    registry.markAccessed('a1', 7)

    const hits = registry.getRecentGhostHits(3, 7)
    assert.equal(hits.length, 1)
    assert.equal(hits[0]!.artifactId, 'a1')
    assert.equal(hits[0]!.accessedAfterEviction, 1)
  })

  it('does not count access outside window', () => {
    const registry = new GhostRegistry()
    registry.record({ artifactId: 'a1', tool: 'read_file', target: 'src/foo.ts', evictedAtTurn: 2, originalTokens: 200 })
    registry.markAccessed('a1', 10)

    const hits = registry.getRecentGhostHits(3, 10)
    assert.equal(hits.length, 0)
  })

  it('computes eviction efficiency', () => {
    const registry = new GhostRegistry()
    registry.record({ artifactId: 'a1', tool: 'read_file', target: 'x', evictedAtTurn: 1, originalTokens: 100 })
    registry.record({ artifactId: 'a2', tool: 'bash', target: 'y', evictedAtTurn: 1, originalTokens: 100 })
    registry.record({ artifactId: 'a3', tool: 'grep', target: 'z', evictedAtTurn: 1, originalTokens: 100 })
    registry.markAccessed('a1', 2)

    const eff = registry.getEvictionEfficiency()
    assert.ok(Math.abs(eff - 2 / 3) < 0.01)
  })

  it('caps entries at maxSize', () => {
    const registry = new GhostRegistry({ maxEntries: 5 })
    for (let i = 0; i < 10; i++) {
      registry.record({ artifactId: `a${i}`, tool: 'read_file', target: `f${i}`, evictedAtTurn: i, originalTokens: 100 })
    }
    assert.equal(registry.size(), 5)
  })
})
