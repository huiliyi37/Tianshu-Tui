import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  createContextLayer,
  createContextLayerReport,
  stableLayerDigest,
} from '../context-layer.js'

describe('context-layer', () => {
  it('creates stable digests independent of object key order', () => {
    const a = stableLayerDigest({ b: 2, a: 1 })
    const b = stableLayerDigest({ a: 1, b: 2 })
    assert.equal(a, b)
  })

  it('records stability channel and fingerprint policy', () => {
    const layer = createContextLayer({
      id: 'session-memory',
      label: 'Session Memory',
      stability: 'stable-volatile',
      channel: 'volatile-user-message',
      fingerprint: 'included',
      content: '<session-memory />',
    })

    assert.equal(layer.id, 'session-memory')
    assert.equal(layer.stability, 'stable-volatile')
    assert.equal(layer.channel, 'volatile-user-message')
    assert.equal(layer.fingerprint, 'included')
    assert.ok(layer.digest.startsWith('sha256:'))
  })

  it('creates a report with layers in explicit order', () => {
    const report = createContextLayerReport([
      createContextLayer({
        id: 'current-request',
        label: 'Current Request',
        stability: 'dynamic',
        channel: 'current-user-message',
        fingerprint: 'excluded',
        content: 'fix bug',
      }),
      createContextLayer({
        id: 'system',
        label: 'Stable System Prompt',
        stability: 'stable',
        channel: 'system',
        fingerprint: 'included',
        content: 'system prompt',
      }),
    ])

    assert.deepEqual(report.layers.map(l => l.id), ['system', 'current-request'])
    assert.equal(report.fingerprintIncluded.length, 1)
    assert.equal(report.fingerprintIncluded[0]!.id, 'system')
  })

  it('estimates tokens from content length', () => {
    const layer = createContextLayer({
      id: 'system',
      label: 'System',
      stability: 'stable',
      channel: 'system',
      fingerprint: 'included',
      content: 'a'.repeat(100),
    })
    assert.equal(layer.tokenEstimate, 25)
  })

  it('uses provided tokenEstimate over calculated', () => {
    const layer = createContextLayer({
      id: 'system',
      label: 'System',
      stability: 'stable',
      channel: 'system',
      fingerprint: 'included',
      content: 'short',
      tokenEstimate: 999,
    })
    assert.equal(layer.tokenEstimate, 999)
  })
})
