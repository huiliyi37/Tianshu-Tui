import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { RoutingMetricsCollector } from '../routing-metrics.js'

describe('RoutingMetricsCollector', () => {
  it('starts empty', () => {
    const m = new RoutingMetricsCollector()
    assert.equal(m.getStats().total, 0)
    assert.equal(m.getStats().switches, 0)
  })

  it('records events and computes stats', () => {
    const m = new RoutingMetricsCollector()
    m.record({ turn: 1, inferredTask: 'code_edit', recommendedModel: 'fast', currentModel: 'large', switched: true, reason: 'edit', timestamp: 1 })
    m.record({ turn: 2, inferredTask: 'code_edit', recommendedModel: 'fast', currentModel: 'fast', switched: false, reason: 'edit', timestamp: 2 })
    m.record({ turn: 3, inferredTask: 'repo_summarization', recommendedModel: 'large', currentModel: 'fast', switched: true, reason: 'search', timestamp: 3 })

    const stats = m.getStats()
    assert.equal(stats.total, 3)
    assert.equal(stats.switches, 2)
    assert.equal(stats.byTask['code_edit'], 2)
    assert.equal(stats.byTask['repo_summarization'], 1)
  })

  it('returns copied events array', () => {
    const m = new RoutingMetricsCollector()
    m.record({ turn: 1, inferredTask: 'code_edit', recommendedModel: 'a', currentModel: 'b', switched: false, reason: '', timestamp: 1 })
    const events = m.getEvents()
    assert.equal(events.length, 1)
    events.push({} as any)
    assert.equal(m.getEvents().length, 1)
  })

  it('clears all events', () => {
    const m = new RoutingMetricsCollector()
    m.record({ turn: 1, inferredTask: 'code_edit', recommendedModel: 'a', currentModel: 'b', switched: false, reason: '', timestamp: 1 })
    m.clear()
    assert.equal(m.getStats().total, 0)
  })
})
