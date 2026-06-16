import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { RetrospectInput, SensoriumEntry, ToolEventSummary } from '../retrospect.js'
import {
  BREADTH_TOOLS,
  COMPLEXITY_THRESHOLD,
  FAST_TURN_THRESHOLD,
  anchorBreakShadowKind,
  buildAnchorBreakShadowEvent,
  breadthToolsUsed,
  deriveCandidateForeignDomains,
  persistAnchorBreakShadow,
  shouldShadowUnderExploredConvergence,
} from '../anchor-break-shadow.js'
import { createAnchorBreakShadowHook } from '../hooks/anchor-break-shadow-hook.js'
import { StarDomainRegistry } from '../star-domain-registry.js'
import type { RuntimeHookContext } from '../runtime-hooks.js'

// ─── shouldShadowUnderExploredConvergence (truth table) ───────────────

test('shouldShadow: complex + fast + no breadth tool → true', () => {
  assert.equal(
    shouldShadowUnderExploredConvergence({ complexityMax: 0.8, turns: 2, toolNames: ['edit', 'write_file'] }),
    true,
  )
})

test('shouldShadow: used a breadth tool → false (explored outside anchor)', () => {
  assert.equal(
    shouldShadowUnderExploredConvergence({ complexityMax: 0.9, turns: 2, toolNames: ['edit', 'semantic_search'] }),
    false,
  )
})

test('shouldShadow: simple task (low complexity) → false', () => {
  assert.equal(
    shouldShadowUnderExploredConvergence({ complexityMax: 0.3, turns: 2, toolNames: ['edit'] }),
    false,
  )
})

test('shouldShadow: slow convergence (many turns) → false', () => {
  assert.equal(
    shouldShadowUnderExploredConvergence({ complexityMax: 0.9, turns: 12, toolNames: ['edit'] }),
    false,
  )
})

test('shouldShadow: boundary values (== thresholds) → true', () => {
  assert.equal(
    shouldShadowUnderExploredConvergence({
      complexityMax: COMPLEXITY_THRESHOLD,
      turns: FAST_TURN_THRESHOLD,
      toolNames: ['edit'],
    }),
    true,
  )
})

test('breadthToolsUsed: returns deduped intersection with BREADTH_TOOLS', () => {
  assert.deepEqual(
    breadthToolsUsed(['edit', 'web_search', 'web_search', 'recall', 'grep']).sort(),
    ['recall', 'web_search'],
  )
  assert.ok(BREADTH_TOOLS.has('delegate_task'))
})

// ─── deriveCandidateForeignDomains ────────────────────────────────────

test('deriveCandidateForeignDomains: orthogonal ids, excludes active, capped', () => {
  const registry = new StarDomainRegistry()
  const result = deriveCandidateForeignDomains('tianshu', 'optimize the build cache', registry)
  assert.ok(result.length > 0 && result.length <= 3)
  assert.ok(!result.includes('tianshu'))
})

test('deriveCandidateForeignDomains: registry missing → []', () => {
  assert.deepEqual(deriveCandidateForeignDomains('tianshu', 'anything', undefined), [])
  assert.deepEqual(deriveCandidateForeignDomains(null, 'anything', null), [])
})

// ─── buildAnchorBreakShadowEvent ──────────────────────────────────────

test('buildAnchorBreakShadowEvent: full schema, hashed objective, explored flag', () => {
  const event = buildAnchorBreakShadowEvent({
    sessionId: 's1',
    objective: 'refactor the agent loop',
    complexityMax: 0.7,
    turns: 3,
    toolNames: ['edit', 'write_file'],
    candidateForeignDomains: ['tianfu', 'pojun'],
    timestamp: 123,
  })
  assert.equal(event.schemaVersion, 1)
  assert.equal(event.sessionId, 's1')
  assert.equal(event.objectiveHash.length, 16)
  assert.equal(event.complexityMax, 0.7)
  assert.equal(event.turns, 3)
  assert.deepEqual(event.breadthToolsUsed, [])
  assert.equal(event.exploredOutsideAnchor, false)
  assert.deepEqual(event.candidateForeignDomains, ['tianfu', 'pojun'])
  assert.equal(event.timestamp, 123)
})

test('buildAnchorBreakShadowEvent: exploredOutsideAnchor reflects breadth tool usage', () => {
  const event = buildAnchorBreakShadowEvent({
    sessionId: 's2',
    objective: 'x',
    complexityMax: 0.6,
    turns: 2,
    toolNames: ['edit', 'recall'],
    candidateForeignDomains: [],
  })
  assert.deepEqual(event.breadthToolsUsed, ['recall'])
  assert.equal(event.exploredOutsideAnchor, true)
})

// ─── persistAnchorBreakShadow ─────────────────────────────────────────

test('persistAnchorBreakShadow: writes via saveBanditState with namespaced kind', () => {
  const calls: Array<{ kind: string; json: string }> = []
  const store = { saveBanditState: (kind: string, json: string) => calls.push({ kind, json }) }
  const event = buildAnchorBreakShadowEvent({
    sessionId: 's3', objective: 'o', complexityMax: 0.6, turns: 2, toolNames: [], candidateForeignDomains: [], timestamp: 7,
  })
  persistAnchorBreakShadow(store, event)
  assert.equal(calls.length, 1)
  assert.equal(calls[0]!.kind, anchorBreakShadowKind(event))
  assert.match(calls[0]!.kind, /^anchor_break_shadow:s3:7$/)
  assert.equal(JSON.parse(calls[0]!.json).sessionId, 's3')
})

test('persistAnchorBreakShadow: swallows store errors; null store is no-op', () => {
  const throwing = { saveBanditState: () => { throw new Error('db down') } }
  const event = buildAnchorBreakShadowEvent({
    sessionId: 's4', objective: 'o', complexityMax: 0.6, turns: 2, toolNames: [], candidateForeignDomains: [],
  })
  assert.doesNotThrow(() => persistAnchorBreakShadow(throwing, event))
  assert.doesNotThrow(() => persistAnchorBreakShadow(null, event))
})

// ─── hook: zero-behavior-change guard ─────────────────────────────────

function entry(complexity: number, turn: number): SensoriumEntry {
  return {
    ts: turn, turn, phase: 'execute', momentum: 0.5, pressure: 0.3,
    confidence: 0.7, complexity, freshness: 0.8, stability: 0.6,
    strategy: { reasoningEffort: 'medium', shouldEscalate: false, thetaInterval: 5 },
  }
}

function retrospectInput(entries: SensoriumEntry[], toolEvents: ToolEventSummary[]): RetrospectInput {
  return { sensoriumEntries: entries, gitLog: [], toolEvents, evidenceSummary: { filesModified: 0, verifiedCount: 0 } }
}

/** ctx whose effects all throw — proves the hook never touches effects. */
function guardCtx(): RuntimeHookContext {
  const boom = (name: string) => () => { throw new Error(`effects.${name} must not be called`) }
  return {
    snapshot: {} as RuntimeHookContext['snapshot'],
    effects: {
      setSensorium: boom('setSensorium'), setStrategy: boom('setStrategy'), setVigor: boom('setVigor'),
      setGitChangeRate: boom('setGitChangeRate'), injectUserMessage: boom('injectUserMessage'),
      requestThetaCheck: boom('requestThetaCheck'), emitPhaseChange: boom('emitPhaseChange'),
      emitDecisionShift: boom('emitDecisionShift'), markClaimStale: boom('markClaimStale'),
    },
  }
}

test('hook: persists on under-explored convergence, never touches effects', () => {
  const calls: Array<{ kind: string; json: string }> = []
  const hook = createAnchorBreakShadowHook({
    store: { saveBanditState: (kind, json) => calls.push({ kind, json }) },
    buildRetrospectInput: () => retrospectInput([entry(0.8, 0), entry(0.6, 1)], [{ turn: 0, name: 'edit', status: 'ok' }]),
    getSessionId: () => 'sess',
    getObjective: () => 'design the cache layer',
    getActiveDomainId: () => 'tianshu',
    domainRegistry: new StarDomainRegistry(),
  })
  assert.doesNotThrow(() => hook.run(guardCtx()))
  assert.equal(calls.length, 1)
  const event = JSON.parse(calls[0]!.json)
  assert.equal(event.sessionId, 'sess')
  assert.equal(event.exploredOutsideAnchor, false)
})

test('hook: no persist when a breadth tool was used', () => {
  const calls: unknown[] = []
  const hook = createAnchorBreakShadowHook({
    store: { saveBanditState: (kind, json) => calls.push({ kind, json }) },
    buildRetrospectInput: () => retrospectInput(
      [entry(0.8, 0)],
      [{ turn: 0, name: 'semantic_search', status: 'ok' }],
    ),
    getSessionId: () => 'sess',
  })
  hook.run(guardCtx())
  assert.equal(calls.length, 0)
})

test('hook: no store → no-op, no throw', () => {
  const hook = createAnchorBreakShadowHook({
    store: null,
    buildRetrospectInput: () => retrospectInput([entry(0.9, 0)], []),
    getSessionId: () => 'sess',
  })
  assert.doesNotThrow(() => hook.run(guardCtx()))
})
