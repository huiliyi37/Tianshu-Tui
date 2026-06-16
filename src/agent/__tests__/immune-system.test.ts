import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { InnateLayer } from '../immune-innate.js'
import { ApcAggregator } from '../immune-apc.js'
import { ImmuneAdaptiveLayer } from '../immune-adaptive.js'

describe('InnateLayer', () => {
  it('detects tool repetition for successful calls', () => {
    const layer = new InnateLayer()
    const signals1 = layer.check({ toolName: 'grep', fingerprint: 'abc123', turn: 1, isError: false })
    assert.equal(signals1.length, 0)
    layer.check({ toolName: 'grep', fingerprint: 'abc123', turn: 2, isError: false })
    const signals3 = layer.check({ toolName: 'grep', fingerprint: 'abc123', turn: 3, isError: false })
    assert.equal(signals3.length, 1)
    assert.equal(signals3[0]!.kind, 'tool_repeat')
  })

  it('does NOT flag tool_repeat for error-only calls — infra failures ≠ logic loops', () => {
    const layer = new InnateLayer()
    layer.check({ toolName: 'grep', fingerprint: 'err1', turn: 1, isError: true })
    layer.check({ toolName: 'grep', fingerprint: 'err1', turn: 2, isError: true })
    const signals = layer.check({ toolName: 'grep', fingerprint: 'err1', turn: 3, isError: true })
    assert.equal(signals.length, 0, '3 error-only calls should not trigger tool_repeat')
  })

  it('detects token spike', () => {
    const layer = new InnateLayer()
    layer.check({ toolName: 'read', fingerprint: 'a', turn: 1, tokenUsage: 100 })
    layer.check({ toolName: 'read', fingerprint: 'b', turn: 2, tokenUsage: 100 })
    layer.check({ toolName: 'read', fingerprint: 'c', turn: 3, tokenUsage: 100 })
    const signals = layer.check({ toolName: 'read', fingerprint: 'd', turn: 4, tokenUsage: 500 })
    const spike = signals.find(s => s.kind === 'token_spike')
    assert.ok(spike)
    assert.ok(spike.severity > 0)
  })
})

describe('ApcAggregator', () => {
  it('does not activate without pattern match', () => {
    const apc = new ApcAggregator()
    apc.collect({ kind: 'tool_repeat', severity: 0.8, turn: 1, source: 'grep' })
    apc.collect({ kind: 'token_spike', severity: 0.6, turn: 2, source: 'read' })
    const decision = apc.evaluate(false, 3)
    assert.equal(decision.shouldActivate, false)
  })

  it('activates with pattern match AND sufficient danger', () => {
    const apc = new ApcAggregator()
    apc.collect({ kind: 'tool_repeat', severity: 0.8, turn: 1, source: 'grep' })
    apc.collect({ kind: 'token_spike', severity: 0.6, turn: 2, source: 'read' })
    const decision = apc.evaluate(true, 3)
    assert.equal(decision.shouldActivate, true)
    assert.ok(decision.confidence > 0)
  })

  it('does not activate with pattern match but low danger', () => {
    const apc = new ApcAggregator()
    apc.collect({ kind: 'tool_repeat', severity: 0.2, turn: 1, source: 'grep' })
    const decision = apc.evaluate(true, 2)
    assert.equal(decision.shouldActivate, false)
  })

  it('ignores old signals outside window', () => {
    const apc = new ApcAggregator()
    apc.collect({ kind: 'tool_repeat', severity: 0.9, turn: 1, source: 'grep' })
    apc.collect({ kind: 'token_spike', severity: 0.9, turn: 2, source: 'read' })
    // Evaluate at turn 20 — signals from turn 1-2 are outside 10-turn window
    const decision = apc.evaluate(true, 20)
    assert.equal(decision.shouldActivate, false)
  })
})

describe('ImmuneAdaptiveLayer', () => {
  it('records and looks up memory', () => {
    const layer = new ImmuneAdaptiveLayer()
    layer.recordSuccess('doom:grep:abc', { type: 'quarantine', targetFile: 'src/foo.ts' }, 10)
    const memory = layer.lookup('doom:grep:abc')
    assert.ok(memory)
    assert.equal(memory.response.type, 'quarantine')
    assert.equal(memory.response.targetFile, 'src/foo.ts')
    assert.equal(memory.hitCount, 1)
  })

  it('increases affinity on repeated success', () => {
    const layer = new ImmuneAdaptiveLayer()
    layer.recordSuccess('pattern1', { type: 'quarantine' }, 10)
    const score1 = layer.lookup('pattern1')!.affinityScore
    layer.recordSuccess('pattern1', { type: 'quarantine' }, 20)
    const score2 = layer.lookup('pattern1')!.affinityScore
    assert.ok(score2 > score1)
  })

  it('decreases affinity on failure', () => {
    const layer = new ImmuneAdaptiveLayer()
    layer.recordSuccess('pattern1', { type: 'quarantine' }, 10)
    const score1 = layer.lookup('pattern1')!.affinityScore
    layer.recordFailure('pattern1')
    const score2 = layer.lookup('pattern1')!.affinityScore
    assert.ok(score2 < score1)
  })

  it('negative selection rejects patterns matching normal behavior', () => {
    const layer = new ImmuneAdaptiveLayer()
    layer.registerNormal('normal-fingerprint')
    layer.recordSuccess('normal-fingerprint', { type: 'deposit_warning' }, 10)
    assert.equal(layer.lookup('normal-fingerprint'), null)
  })

  it('decay removes old low-affinity memories', () => {
    const layer = new ImmuneAdaptiveLayer()
    layer.recordSuccess('old-pattern', { type: 'deposit_warning' }, 1)
    // Manually lower affinity
    const mem = layer.lookup('old-pattern')!
    mem.affinityScore = 0.1
    mem.lastHit = 1
    layer.decay(300)
    assert.equal(layer.lookup('old-pattern'), null)
  })

  it('export and import round-trips', () => {
    const layer = new ImmuneAdaptiveLayer()
    layer.recordSuccess('p1', { type: 'quarantine' }, 10)
    layer.recordSuccess('p2', { type: 'boost_healthy' }, 20)
    const exported = layer.export()
    const layer2 = new ImmuneAdaptiveLayer()
    layer2.import(exported)
    assert.equal(layer2.size(), 2)
    assert.ok(layer2.lookup('p1'))
  })
})
