import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { PhysarumEngine } from '../physarum-engine.js'
import { DEFAULT_PHYSARUM_CONFIG } from '../physarum-types.js'

// Stub MeridianDb — PhysarumEngine only uses it for future persistence
const stubDb = {} as any

describe('PhysarumEngine', () => {
  it('records flow and increases edge weight', () => {
    const engine = new PhysarumEngine(stubDb)
    engine.recordFlow('a.ts', 'b.ts', 1)
    engine.recordFlow('a.ts', 'b.ts', 2)
    const edge = engine.getEdge('a.ts', 'b.ts')
    assert.ok(edge)
    assert.ok(edge.weight > 1.0)
    assert.equal(edge.activationCount, 2)
  })

  it('batch evolve prunes weak unconsolidated edges', () => {
    const config = { ...DEFAULT_PHYSARUM_CONFIG, pruneThreshold: 0.5, tauShort: 2 }
    const engine = new PhysarumEngine(stubDb, config)
    engine.recordFlow('a.ts', 'b.ts', 1)
    // Advance far enough for decay to kill it
    const pruned = engine.batchEvolve(100)
    assert.ok(pruned >= 1)
    assert.equal(engine.getEdge('a.ts', 'b.ts'), undefined)
  })

  it('consolidated edges resist pruning', () => {
    const config = { ...DEFAULT_PHYSARUM_CONFIG, consolidationThreshold: 3, pruneThreshold: 0.01, tauShort: 2 }
    const engine = new PhysarumEngine(stubDb, config)
    for (let i = 1; i <= 5; i++) engine.recordFlow('a.ts', 'b.ts', i)
    const edge = engine.getEdge('a.ts', 'b.ts')!
    assert.equal(edge.consolidated, true)
    engine.batchEvolve(200)
    assert.ok(engine.getEdge('a.ts', 'b.ts') !== undefined)
  })

  it('homeostatic scaling caps node total weight', () => {
    const config = { ...DEFAULT_PHYSARUM_CONFIG, synapticBudget: 5.0 }
    const engine = new PhysarumEngine(stubDb, config)
    // Create many strong edges from same node
    for (let i = 0; i < 10; i++) {
      for (let t = 1; t <= 5; t++) engine.recordFlow('hub.ts', `leaf${i}.ts`, t)
    }
    engine.batchEvolve(6)
    // Total weight from hub should be capped
    let total = 0
    for (let i = 0; i < 10; i++) {
      const e = engine.getEdge('hub.ts', `leaf${i}.ts`)
      if (e) total += e.weight
    }
    assert.ok(total <= config.synapticBudget + 0.01)
  })

  it('STDP updates direction', () => {
    const engine = new PhysarumEngine(stubDb)
    engine.recordFlow('a.ts', 'b.ts', 1)
    engine.recordSequentialEdit('a.ts', 'b.ts', 2) // a edited 2 turns before b
    const edge = engine.getEdge('a.ts', 'b.ts')!
    assert.ok(edge.direction !== 0)
  })

  it('freeze prevents evolution', () => {
    const engine = new PhysarumEngine(stubDb)
    engine.recordFlow('a.ts', 'b.ts', 1)
    engine.freezeNode('a.ts', 100)
    const w1 = engine.getEdge('a.ts', 'b.ts')!.weight
    engine.recordFlow('a.ts', 'b.ts', 2)
    const w2 = engine.getEdge('a.ts', 'b.ts')!.weight
    assert.equal(w1, w2)
  })

  it('SOC criticality returns valid state', () => {
    const engine = new PhysarumEngine(stubDb)
    // Not enough data → default critical
    assert.equal(engine.getCriticality(), 'critical')
    // Add avalanche data
    for (let i = 0; i < 20; i++) engine.recordAvalanche(i + 1, i)
    const c = engine.getCriticality()
    assert.ok(['subcritical', 'critical', 'supercritical'].includes(c))
  })

  it('getStats returns correct counts', () => {
    const engine = new PhysarumEngine(stubDb)
    engine.recordFlow('a.ts', 'b.ts', 1)
    engine.recordFlow('a.ts', 'c.ts', 1)
    const stats = engine.getStats()
    assert.equal(stats.prunedThisTurn, 0)
  })
})
