import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import type { ModelCapabilityCard } from '../../model/capability.js'
import { PromptEngine } from '../../prompt/engine.js'
import { ToolRegistry } from '../../tools/registry.js'
import type { StreamClient } from '../../api/stream-client.js'
import { AgentLoop } from '../loop.js'
import { SessionContext } from '../context.js'
import {
  buildModelRoutingShadowEvent,
  hashObjective,
  inferLegacyRoutingRecommendation,
  persistModelRoutingShadow,
  routingShadowKind,
} from '../model-routing-shadow.js'

const sensorium = {
  complexity: 0.4,
  pressure: 0.2,
  confidence: 0.8,
  stability: 0.7,
}

const cards: ModelCapabilityCard[] = [
  { model: 'flash', toolUseReliability: 0.4, jsonStability: 0.6, editSuccessRate: 0.3, testRepairRate: 0.3, contextWindow: 128_000, cacheEconomics: 'medium', recommendedTasks: [] },
  { model: 'pro', toolUseReliability: 0.9, jsonStability: 0.9, editSuccessRate: 0.9, testRepairRate: 0.8, contextWindow: 512_000, cacheEconomics: 'strong', recommendedTasks: [] },
]

function makeEngine() {
  return new PromptEngine({
    model: 'flash',
    maxTokens: 1024,
    staticCtx: { tools: [] },
    volatileCtx: { cwd: '/tmp/model-routing-shadow-test' },
  })
}

describe('model routing shadow telemetry', () => {
  it('hashes objectives deterministically without exposing raw text', () => {
    const hash = hashObjective('implement routing shadow telemetry')
    assert.equal(hash, hashObjective('implement routing shadow telemetry'))
    assert.equal(hash.length, 16)
    assert.notEqual(hash, 'implement routing shadow telemetry')
  })

  it('routing shadow kind includes sessionId turn timestamp for append-only persistence', () => {
    assert.notEqual(
      routingShadowKind({ sessionId: 's1', turn: 1, timestamp: 10 }),
      routingShadowKind({ sessionId: 's2', turn: 1, timestamp: 10 }),
    )
    assert.notEqual(
      routingShadowKind({ sessionId: 's1', turn: 1, timestamp: 10 }),
      routingShadowKind({ sessionId: 's1', turn: 1, timestamp: 11 }),
    )
  })

  it('records legacy recommendation without invoking onModelSwitch when recommendation differs', () => {
    let switchCalls = 0
    const legacyRouting = inferLegacyRoutingRecommendation([
      { name: 'edit_file', isError: false },
    ], cards)
    const event = buildModelRoutingShadowEvent({
      sessionId: 's1',
      turn: 3,
      objective: 'edit source',
      currentModel: 'flash',
      legacyRouting,
      sensorium,
      timestamp: 123,
    })

    const storeCalls: Array<{ kind: string; json: string }> = []
    persistModelRoutingShadow({
      saveBanditState: (kind, json) => { storeCalls.push({ kind, json }) },
    }, event)

    assert.equal(switchCalls, 0)
    assert.equal(event.currentModel, 'flash')
    assert.equal(event.legacyRouterRecommendedModel, 'pro')
    assert.equal(storeCalls.length, 1)
    assert.equal(storeCalls[0]!.kind, 'routing_shadow:s1:3:123')
  })

  it('persists EFE recommendation as shadow telemetry without switching models', () => {
    let switchCalls = 0
    const storeCalls: Array<{ kind: string; json: string }> = []
    const store = {
      saveBanditState: (kind: string, json: string) => { storeCalls.push({ kind, json }) },
    }
    const loop = new AgentLoop({
      client: { stream: async () => {} } as unknown as StreamClient,
      promptEngine: makeEngine(),
      toolRegistry: new ToolRegistry(),
      maxTurns: 1,
      contextWindow: 1_000_000,
      compact: { enabled: false, autoThreshold: 800_000, autoFloor: 500_000, model: 'flash' },
      fsWatcherEnabled: false,
      modelCards: cards,
      meridianIndexer: { getDb: () => store } as any,
      getCurrentModel: () => 'flash',
      onModelSwitch: () => { switchCalls++ },
    }, new SessionContext(), '/tmp/model-routing-shadow-test')

    ;(loop as any).recordModelRoutingShadow({
      complexity: 0.9,
      pressure: 0.85,
      confidence: 0.25,
      stability: 0.35,
      momentum: 0,
      freshness: 0.5,
    }, {
      epistemicValue: 0.85,
      pragmaticValue: 0.25,
      noveltyBonus: 0.2,
      precision: 0.7,
    })

    const shadowCall = storeCalls.find(call => call.kind.startsWith('routing_shadow:'))
    assert.ok(shadowCall, 'routing shadow event should be persisted')
    const event = JSON.parse(shadowCall.json)
    assert.equal(event.currentModel, 'flash')
    assert.equal(event.efeRecommendedModel, 'pro')
    assert.equal(switchCalls, 0)
  })

  it('persist is no-op safe when store is missing or throws', () => {
    const event = buildModelRoutingShadowEvent({
      sessionId: 's1',
      turn: 1,
      objective: 'x',
      currentModel: 'flash',
      sensorium,
      timestamp: 1,
    })
    assert.doesNotThrow(() => persistModelRoutingShadow(undefined, event))
    assert.doesNotThrow(() => persistModelRoutingShadow({ saveBanditState: () => { throw new Error('db unavailable') } }, event))
  })
})
