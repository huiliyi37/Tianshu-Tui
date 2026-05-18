import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { createDefaultRuntimeHooks } from '../create-runtime-hooks.js'

describe('createDefaultRuntimeHooks', () => {
  it('returns 7 hooks in the correct phase order without playbook deps', () => {
    const hooks = createDefaultRuntimeHooks({
      stigmergyDeposit: async () => {},
      stigmergyQuery: async () => [],
      getEvidenceState: () => ({ filesModified: 0, verifiedCount: 0 }),
      setLoadedPheromones: () => {},
      getThetaState: () => ({ interval: 7, lastCheckTurn: 0 }),
      setThetaState: () => {},
      getPredictionAccumulator: () => ({ history: [] }),
    })

    assert.equal(hooks.length, 7)

    const phases = hooks.map(h => h.phase)
    assert.deepEqual(phases, ['preTurn', 'preTurn', 'preTurn', 'afterPerception', 'postTool', 'postTool', 'postTool'])

    const names = hooks.map(h => h.name)
    assert.deepEqual(names, [
      'perception-runtime',
      'signal-consumer',
      'dissipative-kick',
      'vigor-after-perception',
      'theta-runtime',
      'stigmergy-runtime',
      'vigor-post-tool',
    ])
  })

  it('appends playbook reflect hook when playbook deps are provided', () => {
    const hooks = createDefaultRuntimeHooks({
      stigmergyDeposit: async () => {},
      stigmergyQuery: async () => [],
      getEvidenceState: () => ({ filesModified: 0, verifiedCount: 0 }),
      setLoadedPheromones: () => {},
      getThetaState: () => ({ interval: 7, lastCheckTurn: 0 }),
      setThetaState: () => {},
      getPredictionAccumulator: () => ({ history: [] }),
      playbookStore: { addBullets: () => {} } as never,
      buildRetrospectInput: () => ({ sensoriumEntries: [], gitLog: [], toolEvents: [], evidenceSummary: { filesModified: 0, verifiedCount: 0 } }),
      getDoomLoopLevel: () => 'none',
    })

    assert.equal(hooks.at(-1)?.name, 'playbook-reflect')
    assert.equal(hooks.at(-1)?.phase, 'postTurn')
  })
})
