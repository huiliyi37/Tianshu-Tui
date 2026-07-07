import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { RuntimeHookPipeline, createRuntimeHookContext } from '../runtime-hooks.js'
import { createDefaultRuntimeHooks } from '../create-runtime-hooks.js'

describe('createDefaultRuntimeHooks', () => {
  it('returns 8 hooks in the correct phase order without optional session-end deps', () => {
    const hooks = createDefaultRuntimeHooks({
      stigmergyDeposit: async () => {},
      stigmergyQuery: async () => [],
      getEvidenceState: () => ({ filesRead: new Set(), filesModified: new Set(), verifications: [], deliveryStatus: 'unverified', impactedFiles: new Set(), impactedTests: new Set() }),
      setLoadedPheromones: () => {},
      getThetaState: () => ({ interval: 7, lastCheckTurn: 0, toolCallCount: 0, lastThetaAt: 0, phase: 0, cycleCount: 0 }),
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

  it('appends physarum file access hook when deps are provided', () => {
    const hooks = createDefaultRuntimeHooks({
      stigmergyDeposit: async () => {},
      stigmergyQuery: async () => [],
      getEvidenceState: () => ({ filesRead: new Set(), filesModified: new Set(), verifications: [], deliveryStatus: 'unverified', impactedFiles: new Set(), impactedTests: new Set() }),
      setLoadedPheromones: () => {},
      getThetaState: () => ({ interval: 7, lastCheckTurn: 0, toolCallCount: 0, lastThetaAt: 0, phase: 0, cycleCount: 0 }),
      setThetaState: () => {},
      getPredictionAccumulator: () => ({ history: [] }),
      physarumFileAccess: { getPhysarum: () => null },
    })

    assert.equal(hooks.at(-1)?.name, 'physarum-file-access')
    assert.equal(hooks.at(-1)?.phase, 'postTool')
  })

  it('appends playbook reflect hook when playbook deps are provided', () => {
    const hooks = createDefaultRuntimeHooks({
      stigmergyDeposit: async () => {},
      stigmergyQuery: async () => [],
      getEvidenceState: () => ({ filesRead: new Set(), filesModified: new Set(), verifications: [], deliveryStatus: 'unverified', impactedFiles: new Set(), impactedTests: new Set() }),
      setLoadedPheromones: () => {},
      getThetaState: () => ({ interval: 7, lastCheckTurn: 0, toolCallCount: 0, lastThetaAt: 0, phase: 0, cycleCount: 0 }),
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
      getThetaState: () => ({ interval: 7, lastCheckTurn: 0, toolCallCount: 0, lastThetaAt: 0, phase: 0, cycleCount: 0 }),
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
      getThetaState: () => ({ interval: 7, lastCheckTurn: 0, toolCallCount: 0, lastThetaAt: 0, phase: 0, cycleCount: 0 }),
      setThetaState: () => {},
      getPredictionAccumulator: () => ({ history: [] }),
      telemetryWriter: { write: () => {}, flush: async () => {} },
      dream: { cwd: '/tmp/project', sessionId: 'session-1', getDecisions: () => [], getTrajectory: () => [] },
    })

    assert.deepEqual(hooks.slice(-3).map(h => [h.name, h.phase]), [
      ['dream-distill', 'postSession'],
      ['skill-distill', 'postSession'],
      ['telemetry-flush', 'postSession'],
    ])
  })

  it('registers skill-distill alongside dream, and skips it when disabled', () => {
    const base = {
      stigmergyDeposit: async () => {},
      stigmergyQuery: async () => [],
      getEvidenceState: () => ({ filesRead: new Set<string>(), filesModified: new Set<string>(), verifications: [], deliveryStatus: 'unverified' as const, impactedFiles: new Set<string>(), impactedTests: new Set<string>() }),
      setLoadedPheromones: () => {},
      getThetaState: () => ({ interval: 7, lastCheckTurn: 0, toolCallCount: 0, lastThetaAt: 0, phase: 0, cycleCount: 0 }),
      setThetaState: () => {},
      getPredictionAccumulator: () => ({ history: [] }),
      dream: { cwd: '/tmp/project', sessionId: 'session-1', getDecisions: () => [], getTrajectory: () => [] },
    }

    const withDistill = createDefaultRuntimeHooks(base)
    assert.ok(withDistill.some(h => h.name === 'skill-distill'), 'skill-distill registered by default with dream deps')

    const disabled = createDefaultRuntimeHooks({ ...base, skillDistillDisabled: true })
    assert.ok(!disabled.some(h => h.name === 'skill-distill'), 'skill-distill suppressed when disabled')
    assert.ok(disabled.some(h => h.name === 'dream-distill'), 'dream still registered when only skill-distill disabled')
  })

  it('does not register songline hook unless explicitly enabled', () => {
    const hooks = createDefaultRuntimeHooks({
      stigmergyDeposit: async () => {},
      stigmergyQuery: async () => [],
      getEvidenceState: () => ({ filesRead: new Set(), filesModified: new Set(), verifications: [], deliveryStatus: 'unverified', impactedFiles: new Set(), impactedTests: new Set() }),
      setLoadedPheromones: () => {},
      getThetaState: () => ({ interval: 7, lastCheckTurn: 0, toolCallCount: 0, lastThetaAt: 0, phase: 0, cycleCount: 0 }),
      setThetaState: () => {},
      getPredictionAccumulator: () => ({ history: [] }),
      getTaskSummary: () => ({ taskId: 'task-1', eventCount: 1, readFileCount: 0, writeFileCount: 0, ownedFileCount: 0, verificationCount: 0, verificationStatus: 'verified', firstEventAt: 1, lastEventAt: 1 }),
    })

    assert.equal(hooks.some(h => h.name === 'songline-runtime'), false)
  })

  it('registers songline hook when explicitly enabled and deposits on postSession', async () => {
    const deposits: any[] = []
    const hooks = createDefaultRuntimeHooks({
      stigmergyDeposit: async deposit => { deposits.push(deposit) },
      stigmergyQuery: async () => [],
      getEvidenceState: () => ({ filesRead: new Set(), filesModified: new Set(), verifications: [], deliveryStatus: 'unverified', impactedFiles: new Set(), impactedTests: new Set() }),
      setLoadedPheromones: () => {},
      getThetaState: () => ({ interval: 7, lastCheckTurn: 0, toolCallCount: 0, lastThetaAt: 0, phase: 0, cycleCount: 0 }),
      setThetaState: () => {},
      getPredictionAccumulator: () => ({ history: [] }),
      songlineEnabled: true,
      getTaskSummary: () => ({ taskId: 'task-1', eventCount: 1, readFileCount: 0, writeFileCount: 0, ownedFileCount: 0, verificationCount: 1, verificationStatus: 'verified', firstEventAt: 1, lastEventAt: 1 }),
    })

    assert.equal(hooks.at(-1)?.name, 'songline-runtime')
    await new RuntimeHookPipeline(hooks).runPostSession(createRuntimeHookContext({
      cwd: '/tmp/project',
      turn: 1,
      recentToolHistory: [],
      sensorium: null,
      strategy: null,
      vigor: null,
      gitChangeRate: 0,
      season: null,
    }))

    assert.equal(deposits.length, 1)
    assert.equal(deposits[0]!.signal, 'obligation-fulfilled')
  })

  it('does not register hearth-observe hook unless explicitly enabled', () => {
    const hooks = createDefaultRuntimeHooks({
      stigmergyDeposit: async () => {},
      stigmergyQuery: async () => [],
      getEvidenceState: () => ({ filesRead: new Set(), filesModified: new Set(), verifications: [], deliveryStatus: 'unverified', impactedFiles: new Set(), impactedTests: new Set() }),
      setLoadedPheromones: () => {},
      getThetaState: () => ({ interval: 7, lastCheckTurn: 0, toolCallCount: 0, lastThetaAt: 0, phase: 0, cycleCount: 0 }),
      setThetaState: () => {},
      getPredictionAccumulator: () => ({ history: [] }),
      getAnchorGraph: () => ({
        nodes: [],
        graphHash: 'hash',
      }) as never,
      getPrevAnchorGraphHash: () => null,
      setPrevAnchorGraphHash: () => {},
    })

    assert.equal(hooks.some(h => h.name === 'hearth-observe'), false)
  })

  it('registers hearth-observe hook when explicitly enabled (postTurn, diagnostic)', () => {
    const hooks = createDefaultRuntimeHooks({
      stigmergyDeposit: async () => {},
      stigmergyQuery: async () => [],
      getEvidenceState: () => ({ filesRead: new Set(), filesModified: new Set(), verifications: [], deliveryStatus: 'unverified', impactedFiles: new Set(), impactedTests: new Set() }),
      setLoadedPheromones: () => {},
      getThetaState: () => ({ interval: 7, lastCheckTurn: 0, toolCallCount: 0, lastThetaAt: 0, phase: 0, cycleCount: 0 }),
      setThetaState: () => {},
      getPredictionAccumulator: () => ({ history: [] }),
      hearthObserveEnabled: true,
      getAnchorGraph: () => ({
        nodes: [],
        graphHash: 'hash',
      }) as never,
      getPrevAnchorGraphHash: () => null,
      setPrevAnchorGraphHash: () => {},
    })

    const hearthHooks = hooks.filter(h => h.name === 'hearth-observe')
    assert.equal(hearthHooks.length, 1)
    assert.equal(hearthHooks[0]!.phase, 'postTurn')
  })

  it('does not register anti-anchoring hooks unless explicitly enabled', () => {
    const hooks = createDefaultRuntimeHooks({
      stigmergyDeposit: async () => {},
      stigmergyQuery: async () => [],
      getEvidenceState: () => ({ filesRead: new Set(), filesModified: new Set(), verifications: [], deliveryStatus: 'unverified', impactedFiles: new Set(), impactedTests: new Set() }),
      setLoadedPheromones: () => {},
      getThetaState: () => ({ interval: 7, lastCheckTurn: 0, toolCallCount: 0, lastThetaAt: 0, phase: 0, cycleCount: 0 }),
      setThetaState: () => {},
      getPredictionAccumulator: () => ({ history: [] }),
      getInitialUserMessage: () => 'refactor auth module',
      callAntiAnchoringSeedModel: async () => 'independent path',
    })

    assert.equal(hooks.some(h => h.name === 'blind-exploration'), false)
    assert.equal(hooks.some(h => h.name === 'mcts-planning'), false)
  })

  it('registers anti-anchoring hooks when explicitly enabled', () => {
    const hooks = createDefaultRuntimeHooks({
      stigmergyDeposit: async () => {},
      stigmergyQuery: async () => [],
      getEvidenceState: () => ({ filesRead: new Set(), filesModified: new Set(), verifications: [], deliveryStatus: 'unverified', impactedFiles: new Set(), impactedTests: new Set() }),
      setLoadedPheromones: () => {},
      getThetaState: () => ({ interval: 7, lastCheckTurn: 0, toolCallCount: 0, lastThetaAt: 0, phase: 0, cycleCount: 0 }),
      setThetaState: () => {},
      getPredictionAccumulator: () => ({ history: [] }),
      antiAnchoring: { enabled: true, blindExploration: true, mctsPlanning: true, branches: 2, planningTurn: 1, projectionThreshold: 0.4, seedMaxTokens: 512, anchorBreakScout: { enabled: false, complexityThreshold: 0.5, minTurn: 3, scoutBudgetMs: 60_000, scoutMaxTokens: 2048 } },
      getInitialUserMessage: () => 'refactor auth module',
      callAntiAnchoringSeedModel: async () => 'independent path',
    })

    assert.equal(hooks.some(h => h.name === 'blind-exploration'), true)
    assert.equal(hooks.some(h => h.name === 'mcts-planning'), true)
    assert.equal(hooks.filter(h => h.phase === 'preTurn').some(h => h.name === 'mcts-planning'), true)
  })
})
