import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { Sensorium } from '../sensorium.js'
import type { RuntimeHookContext } from '../runtime-hooks.js'
import type { DelegationCoordinator, CoordinatorRun, DelegationRequest } from '../coordinator.js'
import { MAX_DELEGATION_DEPTH } from '../coordinator.js'
import {
  SCOUT_PROFILE,
  buildForeignScoutEvent,
  buildForeignScoutRequest,
  foreignScoutEventKind,
  formatScoutInjection,
  persistForeignScoutEvent,
  shouldDispatchForeignScout,
} from '../anchor-break-scout.js'
import { createAnchorBreakScoutHook } from '../hooks/anchor-break-scout-hook.js'
import { StarDomainRegistry } from '../star-domain-registry.js'

// ─── shouldDispatchForeignScout (truth table) ─────────────────────────

const base = {
  enabled: true,
  complexity: 0.8,
  turn: 3,
  seenBreadthTool: false,
  hasScouted: false,
  stuck: false,
}

test('shouldDispatch: complex + mid-turn + no-breadth + healthy + enabled → true', () => {
  assert.equal(shouldDispatchForeignScout(base), true)
})

test('shouldDispatch: disabled → false', () => {
  assert.equal(shouldDispatchForeignScout({ ...base, enabled: false }), false)
})

test('shouldDispatch: already used a breadth tool → false', () => {
  assert.equal(shouldDispatchForeignScout({ ...base, seenBreadthTool: true }), false)
})

test('shouldDispatch: stuck (kick territory) → false', () => {
  assert.equal(shouldDispatchForeignScout({ ...base, stuck: true }), false)
})

test('shouldDispatch: already scouted → false', () => {
  assert.equal(shouldDispatchForeignScout({ ...base, hasScouted: true }), false)
})

test('shouldDispatch: turn below minTurn → false', () => {
  assert.equal(shouldDispatchForeignScout({ ...base, turn: 1 }), false)
})

test('shouldDispatch: complexity below threshold → false', () => {
  assert.equal(shouldDispatchForeignScout({ ...base, complexity: 0.2 }), false)
})

// ─── buildForeignScoutRequest ─────────────────────────────────────────

test('buildForeignScoutRequest: read-only, foreign authority, depth capped-able', () => {
  const req: DelegationRequest = buildForeignScoutRequest({
    parentTurnId: 'p1',
    objective: 'refactor the agent loop',
    foreignDomainId: 'tianfu',
    delegationDepth: 1,
    sessionTurn: 3,
    budget: { maxTurns: 3, maxTokens: 2048, timeoutMs: 60_000, maxRetries: 0 },
  })
  assert.equal(req.kind, 'doc_research')
  assert.equal(req.profile, SCOUT_PROFILE)
  assert.equal(req.authority, 'tianfu')
  assert.equal(req.delegationDepth, 1)
  assert.ok(req.delegationDepth! < MAX_DELEGATION_DEPTH)
  assert.match(req.objective, /tianfu/)
  assert.match(req.objective, /refactor the agent loop/)
  assert.deepEqual(req.scope, {})
})

// ─── formatScoutInjection ─────────────────────────────────────────────

test('formatScoutInjection: wraps packet in 外域-侦察 tag with domain', () => {
  const out = formatScoutInjection('SCOUT FINDINGS', 'pojun')
  assert.match(out, /<外域-侦察 domain="pojun">/)
  assert.match(out, /SCOUT FINDINGS/)
  assert.match(out, /<\/外域-侦察>/)
})

// ─── event + persist ──────────────────────────────────────────────────

test('buildForeignScoutEvent + persist: namespaced kind, swallows errors', () => {
  const event = buildForeignScoutEvent({
    sessionId: 's1', turn: 3, objective: 'o', foreignDomainId: 'tianfu',
    dispatched: true, packetChars: 42, reason: 'ok', timestamp: 9,
  })
  assert.equal(event.schemaVersion, 1)
  assert.equal(event.objectiveHash.length, 16)
  assert.match(foreignScoutEventKind(event), /^anchor_break_scout:s1:3:9$/)

  const calls: Array<{ kind: string; json: string }> = []
  persistForeignScoutEvent({ saveBanditState: (kind, json) => calls.push({ kind, json }) }, event)
  assert.equal(calls.length, 1)
  assert.equal(JSON.parse(calls[0]!.json).foreignDomainId, 'tianfu')

  const throwing = { saveBanditState: () => { throw new Error('db down') } }
  assert.doesNotThrow(() => persistForeignScoutEvent(throwing, event))
  assert.doesNotThrow(() => persistForeignScoutEvent(null, event))
})

// ─── hook ─────────────────────────────────────────────────────────────

function sensorium(complexity: number, momentum: number, stability: number): Sensorium {
  return { complexity, momentum, stability, confidence: 0.6, pressure: 0.3 } as unknown as Sensorium
}

function ctx(opts: {
  turn: number
  sensorium: Sensorium | null
  tools?: string[]
  recordInject: (m: string) => void
}): RuntimeHookContext {
  const boom = (name: string) => () => { throw new Error(`effects.${name} must not be called`) }
  return {
    snapshot: {
      cwd: '/tmp',
      turn: opts.turn,
      recentToolHistory: (opts.tools ?? []).map(t => ({ tool: t, status: 'ok' as const, target: undefined })),
      sensorium: opts.sensorium,
    } as unknown as RuntimeHookContext['snapshot'],
    effects: {
      setSensorium: boom('setSensorium'), setStrategy: boom('setStrategy'), setVigor: boom('setVigor'),
      setGitChangeRate: boom('setGitChangeRate'),
      injectUserMessage: opts.recordInject,
      requestThetaCheck: boom('requestThetaCheck'), emitPhaseChange: boom('emitPhaseChange'),
      emitDecisionShift: boom('emitDecisionShift'), markClaimStale: boom('markClaimStale'),
    },
  }
}

const enabledConfig = { enabled: true, complexityThreshold: 0.5, minTurn: 3, scoutBudgetMs: 60_000, scoutMaxTokens: 2048 }

function fakeCoordinator(packet: string, delegateCalls: DelegationRequest[]): DelegationCoordinator {
  return {
    delegate: async (req: DelegationRequest): Promise<CoordinatorRun> => {
      delegateCalls.push(req)
      return { status: 'completed', results: [], packet }
    },
  } as unknown as DelegationCoordinator
}

test('hook: dispatches scout + injects packet, only touches injectUserMessage', async () => {
  const injected: string[] = []
  const delegateCalls: DelegationRequest[] = []
  const persisted: unknown[] = []
  const hook = createAnchorBreakScoutHook({
    config: enabledConfig,
    getCoordinator: () => fakeCoordinator('FOREIGN FINDINGS', delegateCalls),
    getSessionId: () => 'sess',
    getObjective: () => 'design the distributed cache invalidation strategy',
    getActiveDomainId: () => 'tianshu',
    domainRegistry: new StarDomainRegistry(),
    store: { saveBanditState: (_k, _j) => persisted.push(_j) },
  })

  await hook.run(ctx({ turn: 3, sensorium: sensorium(0.8, 0.6, 0.7), recordInject: m => injected.push(m) }))

  assert.equal(delegateCalls.length, 1)
  assert.equal(injected.length, 1)
  assert.match(injected[0]!, /<外域-侦察/)
  assert.match(injected[0]!, /FOREIGN FINDINGS/)
  assert.equal(persisted.length, 1)
})

test('hook: once-per-session — second turn does not re-dispatch', async () => {
  const delegateCalls: DelegationRequest[] = []
  const hook = createAnchorBreakScoutHook({
    config: enabledConfig,
    getCoordinator: () => fakeCoordinator('X', delegateCalls),
    getSessionId: () => 'sess',
    getObjective: () => 'design the distributed cache invalidation strategy',
    domainRegistry: new StarDomainRegistry(),
  })
  await hook.run(ctx({ turn: 3, sensorium: sensorium(0.8, 0.6, 0.7), recordInject: () => {} }))
  await hook.run(ctx({ turn: 4, sensorium: sensorium(0.8, 0.6, 0.7), recordInject: () => {} }))
  assert.equal(delegateCalls.length, 1)
})

test('hook: disabled → no dispatch', async () => {
  const delegateCalls: DelegationRequest[] = []
  const hook = createAnchorBreakScoutHook({
    config: { ...enabledConfig, enabled: false },
    getCoordinator: () => fakeCoordinator('X', delegateCalls),
    getSessionId: () => 'sess',
    getObjective: () => 'design the distributed cache invalidation strategy',
    domainRegistry: new StarDomainRegistry(),
  })
  await hook.run(ctx({ turn: 3, sensorium: sensorium(0.8, 0.6, 0.7), recordInject: () => {} }))
  assert.equal(delegateCalls.length, 0)
})

test('hook: breadth tool already used → no dispatch', async () => {
  const delegateCalls: DelegationRequest[] = []
  const hook = createAnchorBreakScoutHook({
    config: enabledConfig,
    getCoordinator: () => fakeCoordinator('X', delegateCalls),
    getSessionId: () => 'sess',
    getObjective: () => 'design the distributed cache invalidation strategy',
    domainRegistry: new StarDomainRegistry(),
  })
  await hook.run(ctx({ turn: 3, sensorium: sensorium(0.8, 0.6, 0.7), tools: ['semantic_search'], recordInject: () => {} }))
  assert.equal(delegateCalls.length, 0)
})

test('hook: stuck (kick territory) → no dispatch', async () => {
  const delegateCalls: DelegationRequest[] = []
  const hook = createAnchorBreakScoutHook({
    config: enabledConfig,
    getCoordinator: () => fakeCoordinator('X', delegateCalls),
    getSessionId: () => 'sess',
    getObjective: () => 'design the distributed cache invalidation strategy',
    domainRegistry: new StarDomainRegistry(),
  })
  // momentum 0.1 < 0.2 && stability 0.1 < 0.3 → shouldKick → stuck
  await hook.run(ctx({ turn: 3, sensorium: sensorium(0.8, 0.1, 0.1), recordInject: () => {} }))
  assert.equal(delegateCalls.length, 0)
})

test('hook: coordinator throws → swallowed, no throw', async () => {
  const hook = createAnchorBreakScoutHook({
    config: enabledConfig,
    getCoordinator: () => ({ delegate: async () => { throw new Error('worker boom') } } as unknown as DelegationCoordinator),
    getSessionId: () => 'sess',
    getObjective: () => 'design the distributed cache invalidation strategy',
    domainRegistry: new StarDomainRegistry(),
  })
  await assert.doesNotReject(() => Promise.resolve(hook.run(ctx({ turn: 3, sensorium: sensorium(0.8, 0.6, 0.7), recordInject: () => {} }))))
})
