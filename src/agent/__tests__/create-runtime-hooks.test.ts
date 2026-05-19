import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { createDefaultRuntimeHooks } from '../create-runtime-hooks.js'

describe('createDefaultRuntimeHooks', () => {
  it('returns 8 hooks in the correct phase order without optional session-end deps', () => {
    const hooks = createDefaultRuntimeHooks({
      stigmergyDeposit: async () => {},
      stigmergyQuery: async () => [],
      getEvidenceState: () => ({ filesRead: new Set(), filesModified: new Set(), verifications: [], deliveryStatus: 'unverified', impactedFiles: new Set(), impactedTests: new Set() }),
      setLoadedPheromones: () => {},
      getThetaState: () => ({ interval: 7, lastCheckTurn: 0 }),
      setThetaState: () => {},
      getPredictionAccumulator: () => ({ history: [] }),
    })

    assert.equal(hooks.length, 9)

    const phases = hooks.map(h => h.phase)
    assert.deepEqual(phases, ['preTurn', 'preTurn', 'preTurn', 'preTurn', 'afterPerception', 'postTool', 'postTool', 'postTool', 'postTool'])

    const names = hooks.map(h => h.name)
    assert.deepEqual(names, [
      'perception-runtime',
      'signal-consumer',
      'courage',
      'dissipative-kick',
      'vigor-after-perception',
      'theta-runtime',
      'stigmergy-runtime',
      'vigor-post-tool',
      'tianshu-radio',
    ])
  })

  it('appends playbook reflect hook when playbook deps are provided', () => {
    const hooks = createDefaultRuntimeHooks({
      stigmergyDeposit: async () => {},
      stigmergyQuery: async () => [],
      getEvidenceState: () => ({ filesRead: new Set(), filesModified: new Set(), verifications: [], deliveryStatus: 'unverified', impactedFiles: new Set(), impactedTests: new Set() }),
      setLoadedPheromones: () => {},
      getThetaState: () => ({ interval: 7, lastCheckTurn: 0 }),
      setThetaState: () => {},
      getPredictionAccumulator: () => ({ history: [] }),
      playbookStore: { addBullets: () => {} } as never,
      buildRetrospectInput: () => ({ sensoriumEntries: [], gitLog: [], toolEvents: [], evidenceSummary: { filesModified: 0, verifiedCount: 0 } }),
      getDoomLoopLevel: () => 'none',
    })

    assert.equal(hooks.at(-1)?.name, 'playbook-reflect')
    assert.equal(hooks.at(-1)?.phase, 'postSession')
  })

  it('appends telemetry flush hook when telemetry writer is provided', () => {
    const hooks = createDefaultRuntimeHooks({
      stigmergyDeposit: async () => {},
      stigmergyQuery: async () => [],
      getEvidenceState: () => ({ filesRead: new Set(), filesModified: new Set(), verifications: [], deliveryStatus: 'unverified', impactedFiles: new Set(), impactedTests: new Set() }),
      setLoadedPheromones: () => {},
      getThetaState: () => ({ interval: 7, lastCheckTurn: 0 }),
      setThetaState: () => {},
      getPredictionAccumulator: () => ({ history: [] }),
      telemetryWriter: { write: () => {}, flush: async () => {} },
    })

    assert.equal(hooks.at(-1)?.name, 'telemetry-flush')
    assert.equal(hooks.at(-1)?.phase, 'postSession')
  })

  it('appends dream hook before telemetry flush when dream deps are provided', () => {
    const hooks = createDefaultRuntimeHooks({
      stigmergyDeposit: async () => {},
      stigmergyQuery: async () => [],
      getEvidenceState: () => ({ filesRead: new Set(), filesModified: new Set(), verifications: [], deliveryStatus: 'unverified', impactedFiles: new Set(), impactedTests: new Set() }),
      setLoadedPheromones: () => {},
      getThetaState: () => ({ interval: 7, lastCheckTurn: 0 }),
      setThetaState: () => {},
      getPredictionAccumulator: () => ({ history: [] }),
      telemetryWriter: { write: () => {}, flush: async () => {} },
      dream: { cwd: '/tmp/project', sessionId: 'session-1', getDecisions: () => [], getTrajectory: () => [] },
    })

    assert.deepEqual(hooks.slice(-2).map(h => [h.name, h.phase]), [
      ['dream-distill', 'postSession'],
      ['telemetry-flush', 'postSession'],
    ])
  })
})
