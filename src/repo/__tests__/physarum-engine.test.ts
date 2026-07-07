import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { PhysarumEngine } from '../physarum-engine.js'
import { DEFAULT_PHYSARUM_CONFIG, type PhysarumPredictionObservation } from '../physarum-types.js'

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

  it('records file access sequences before prediction, including reverse lexicographic direction', () => {
    const engine = new PhysarumEngine(stubDb)
    engine.recordFileAccess('src/b.ts', 1)
    engine.recordFileAccess('src/a.ts', 2)

    const edge = engine.getEdge('src/a.ts', 'src/b.ts')!
    assert.ok(edge)
    assert.ok(edge.direction < 0, 'reverse lexicographic b.ts→a.ts sequence must be negative on a.ts|b.ts')
    assert.equal(engine.predictNext('src/b.ts')[0]?.file, 'src/a.ts')
  })

  it('records shadow prediction observations on the next distinct file access', () => {
    const persisted: any[] = []
    const engine = new PhysarumEngine({
      recordPhysarumPredictionObservation: (observation: PhysarumPredictionObservation) => { persisted.push(observation) },
    } as any)

    engine.recordFileAccess('src/b.ts', 1)
    engine.recordFileAccess('src/a.ts', 2)
    engine.recordFileAccess('src/b.ts', 3)

    const observations = engine.getPredictionObservations()
    assert.equal(observations.length, 1)
    assert.equal(observations[0]!.sourceFile, 'src/a.ts')
    assert.equal(observations[0]!.observedFile, 'src/b.ts')
    assert.equal(observations[0]!.hitRank, 1)
    assert.equal(observations[0]!.leadTurns, 1)
    assert.equal(persisted.length, 1)
  })

  it('records shadow prediction misses without altering the next prediction cycle', () => {
    const engine = new PhysarumEngine(stubDb)
    engine.recordFileAccess('src/a.ts', 1)
    engine.recordFileAccess('src/b.ts', 2)
    engine.recordFileAccess('src/c.ts', 3)

    const observations = engine.getPredictionObservations()
    assert.equal(observations.length, 1)
    assert.equal(observations[0]!.sourceFile, 'src/b.ts')
    assert.equal(observations[0]!.observedFile, 'src/c.ts')
    assert.equal(observations[0]!.hitRank, null)
  })

  it('returns zero shadow stats when no observations are recorded', () => {
    const engine = new PhysarumEngine(undefined)

    const stats = engine.getShadowStats()

    assert.equal(stats.total, 0)
    assert.equal(stats.hitAt1, 0)
    assert.equal(stats.hitAt3, 0)
  })

  it('filters legacy tool-name physarum edges when loading and saving', () => {
    let stored: any[] = [
      { fileA: 'read_file', fileB: 'src/a.ts', weight: 10, flow: 1, consolidated: true, activationCount: 9, lastActivatedTurn: 3, direction: 0 },
      { fileA: 'src/a.ts', fileB: 'src/b.ts', weight: 2, flow: 0, consolidated: false, activationCount: 1, lastActivatedTurn: 4, direction: 0.2 },
      { fileA: 'src/a.ts', fileB: 'docs/note.md', weight: 2, flow: 0, consolidated: false, activationCount: 1, lastActivatedTurn: 4, direction: 0 },
    ]
    const mockDb = {
      savePhysarumEdges: (edges: any[]) => { stored = edges },
      loadPhysarumEdges: () => stored,
    } as any

    const engine = new PhysarumEngine(mockDb)
    engine.loadFromDb()

    assert.equal(engine.getEdge('read_file', 'src/a.ts'), undefined)
    assert.equal(engine.getEdge('src/a.ts', 'docs/note.md'), undefined)
    assert.ok(engine.getEdge('src/a.ts', 'src/b.ts'))
    assert.deepEqual(engine.getLastLoadStats(), {
      loaded: 1,
      discarded: 2,
      discardedSamples: [
        { fileA: 'read_file', fileB: 'src/a.ts' },
        { fileA: 'src/a.ts', fileB: 'docs/note.md' },
      ],
    })

    engine.cleanupPersistedEdges()
    assert.deepEqual(stored.map(e => [e.fileA, e.fileB]), [['src/a.ts', 'src/b.ts']])
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

  it('save + loadFromDb round-trips edges through MeridianDb stub', () => {
    let stored: any[] = []
    const mockDb = {
      savePhysarumEdges: (edges: any[]) => { stored = edges },
      loadPhysarumEdges: () => stored,
    } as any

    const engine1 = new PhysarumEngine(mockDb)
    engine1.recordFlow('x.ts', 'y.ts', 1)
    engine1.recordFlow('x.ts', 'y.ts', 2)
    engine1.recordFlow('x.ts', 'y.ts', 3)
    engine1.save()
    assert.equal(stored.length, 1)

    const engine2 = new PhysarumEngine(mockDb)
    engine2.loadFromDb()
    const edge = engine2.getEdge('x.ts', 'y.ts')
    assert.ok(edge)
    assert.equal(edge.activationCount, 3)
    assert.ok(edge.weight > 1.0)
  })

  describe('structuralEpistemic (Track 1: 经络图×自由能)', () => {
    it('returns undefined with no recent file access', () => {
      const engine = new PhysarumEngine(stubDb)
      assert.equal(engine.structuralEpistemic(), undefined)
    })

    it('frontier files (no edges) score 1', () => {
      const engine = new PhysarumEngine(stubDb)
      engine.recordFileAccess('src/lonely.ts', 1)
      assert.equal(engine.structuralEpistemic(), 1)
    })

    it('heavily connected working set scores lower than a frontier one', () => {
      const trodden = new PhysarumEngine(stubDb)
      // Build heavy edges around hub.ts via repeated co-access
      for (let turn = 1; turn <= 30; turn++) {
        trodden.recordFileAccess('src/hub.ts', turn)
        trodden.recordFileAccess(`src/peer${turn % 3}.ts`, turn)
      }
      const troddenScore = trodden.structuralEpistemic()
      assert.ok(troddenScore !== undefined)

      const frontier = new PhysarumEngine(stubDb)
      frontier.recordFileAccess('src/new-module.ts', 1)
      const frontierScore = frontier.structuralEpistemic()

      assert.ok(frontierScore !== undefined)
      assert.ok(frontierScore > troddenScore, `frontier ${frontierScore} should exceed trodden ${troddenScore}`)
    })

    it('bounded to [0, 1]', () => {
      const engine = new PhysarumEngine(stubDb)
      for (let turn = 1; turn <= 100; turn++) {
        engine.recordFileAccess('src/a.ts', turn)
        engine.recordFileAccess('src/b.ts', turn)
      }
      const score = engine.structuralEpistemic()
      assert.ok(score !== undefined && score >= 0 && score <= 1)
    })
  })
})
