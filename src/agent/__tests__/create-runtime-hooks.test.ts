import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { createDefaultRuntimeHooks } from '../create-runtime-hooks.js'

describe('createDefaultRuntimeHooks', () => {
  it('returns 6 hooks in the correct phase order', () => {
    const hooks = createDefaultRuntimeHooks({
      stigmergyDeposit: async () => {},
      stigmergyQuery: async () => [],
      getEvidenceState: () => ({ filesModified: 0, verifiedCount: 0 }),
      setLoadedPheromones: () => {},
      getThetaState: () => ({ interval: 7, lastCheckTurn: 0 }),
      setThetaState: () => {},
      getPredictionAccumulator: () => ({ history: [] }),
    })

    assert.equal(hooks.length, 6)

    const phases = hooks.map(h => h.phase)
    assert.deepEqual(phases, ['preTurn', 'preTurn', 'afterPerception', 'postTool', 'postTool', 'postTool'])

    const names = hooks.map(h => h.name)
    assert.deepEqual(names, [
      'perception-runtime',
      'dissipative-kick',
      'vigor-after-perception',
      'theta-runtime',
      'stigmergy-runtime',
      'vigor-post-tool',
    ])
  })
})
