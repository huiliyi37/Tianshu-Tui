/**
 * Wave 1 — control-plane pure reducer tests (RED→GREEN).
 *
 * The reducer is pure: no IO, no model calls, no SessionContext, no clock,
 * no randomness. Same input → same frame (idempotent reduce).
 */
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  emptyControlPlaneFrame,
  reduceControlSignals,
  renderControlPlaneAppendix,
  routeFor,
  tickControlSignals,
  type ControlSignal,
} from '../control-plane.js'

function signal(overrides: Partial<ControlSignal> & { key: string }): ControlSignal {
  return {
    kind: 'advisory',
    severity: 'info',
    summary: `fact:${overrides.key}`,
    requiresDecision: false,
    ttlTurns: 2,
    cacheImpact: 'none',
    ...overrides,
  }
}

describe('control-plane reducer', () => {
  it('dedupes same key keeping the highest severity', () => {
    const frame = reduceControlSignals(emptyControlPlaneFrame(), [
      signal({ key: 'worker:1', severity: 'info', summary: 'worker done' }),
      signal({ key: 'worker:1', severity: 'blocking', summary: 'worker gate failed', requiresDecision: true }),
      signal({ key: 'worker:1', severity: 'attention', summary: 'worker needs review' }),
    ])
    assert.equal(frame.signals.length, 1)
    assert.equal(frame.signals[0]?.severity, 'blocking')
    assert.equal(frame.signals[0]?.summary, 'worker gate failed')
  })

  it('blocking signals are never squeezed out by informational volume', () => {
    const noise = Array.from({ length: 20 }, (_, i) =>
      signal({ key: `noise:${i}`, severity: 'info', routeHint: 'appendix' as const }))
    const gate = signal({
      key: 'verification:blocked', kind: 'verification',
      severity: 'blocking', requiresDecision: true,
    })
    const frame = reduceControlSignals(emptyControlPlaneFrame(), [...noise, gate])
    assert.equal(frame.decisionGates.length, 1)
    assert.equal(frame.decisionGates[0]?.key, 'verification:blocked')
    // appendix is capped but the gate lives in its own lane
    assert.ok(frame.appendix.length <= 3)
    assert.ok(!frame.appendix.some(s => s.key === 'verification:blocked'))
  })

  it('expired TTL signals are dropped; tick decrements exactly once', () => {
    const first = reduceControlSignals(emptyControlPlaneFrame(), [
      signal({ key: 'a', ttlTurns: 1 }),
      signal({ key: 'b', ttlTurns: 2 }),
    ])
    assert.equal(first.signals.length, 2)
    const ticked = tickControlSignals(first.signals)
    const second = reduceControlSignals({ ...first, signals: ticked }, [])
    assert.deepEqual(second.signals.map(s => s.key), ['b'])
    const third = reduceControlSignals({ ...second, signals: tickControlSignals(second.signals) }, [])
    assert.equal(third.signals.length, 0)
  })

  it('sorts deterministically: severity desc, then route, then key', () => {
    const frame = reduceControlSignals(emptyControlPlaneFrame(), [
      signal({ key: 'z-info', severity: 'info' }),
      signal({ key: 'a-info', severity: 'info' }),
      signal({ key: 'm-attn', severity: 'attention' }),
      signal({ key: 'b-block', severity: 'blocking', requiresDecision: true }),
    ])
    assert.deepEqual(frame.signals.map(s => s.key), ['b-block', 'm-attn', 'a-info', 'z-info'])
    // Same input in a different submission order → identical frame ordering.
    const shuffled = reduceControlSignals(emptyControlPlaneFrame(), [
      signal({ key: 'm-attn', severity: 'attention' }),
      signal({ key: 'b-block', severity: 'blocking', requiresDecision: true }),
      signal({ key: 'a-info', severity: 'info' }),
      signal({ key: 'z-info', severity: 'info' }),
    ])
    assert.deepEqual(shuffled.signals.map(s => s.key), frame.signals.map(s => s.key))
  })

  it('reduce is idempotent: reducing again with no incoming yields the same frame', () => {
    const frame = reduceControlSignals(emptyControlPlaneFrame(), [
      signal({ key: 'a', severity: 'attention' }),
      signal({ key: 'g', severity: 'blocking', requiresDecision: true }),
    ])
    const again = reduceControlSignals(frame, [])
    assert.deepEqual(again, frame)
  })

  it('revision bumps only when model-visible state (appendix/decision-gate) changes', () => {
    const base = reduceControlSignals(emptyControlPlaneFrame(), [
      signal({ key: 'vis', severity: 'attention', routeHint: 'appendix' }),
    ])
    assert.equal(base.revision, 1)
    // silent-only churn must not bump revision
    const silentChurn = reduceControlSignals(base, [
      signal({ key: 'ledger:x', severity: 'info' }),
    ])
    assert.equal(silentChurn.revision, base.revision)
    // status-only churn must not bump revision either (status is TUI-facing)
    const statusChurn = reduceControlSignals(silentChurn, [
      signal({ key: 'progress:y', severity: 'attention' }),
    ])
    assert.equal(statusChurn.revision, base.revision)
    // a new decision gate is model-visible → bump
    const gated = reduceControlSignals(statusChurn, [
      signal({ key: 'gate:z', severity: 'blocking', requiresDecision: true }),
    ])
    assert.equal(gated.revision, base.revision + 1)
  })

  it('routeFor: decision overrides hint; default info→silent, attention→status; appendix only via hint', () => {
    assert.equal(routeFor(signal({ key: 'a', severity: 'blocking', requiresDecision: true, routeHint: 'silent' })), 'decision-gate')
    assert.equal(routeFor(signal({ key: 'b', severity: 'info' })), 'silent')
    assert.equal(routeFor(signal({ key: 'c', severity: 'attention' })), 'status')
    assert.equal(routeFor(signal({ key: 'd', severity: 'info', routeHint: 'appendix' })), 'appendix')
  })

  it('cacheImpact passes through unmodified', () => {
    const frame = reduceControlSignals(emptyControlPlaneFrame(), [
      signal({ key: 'a', cacheImpact: 'dynamic-tail' }),
      signal({ key: 'b', cacheImpact: 'history-boundary' }),
    ])
    const byKey = new Map(frame.signals.map(s => [s.key, s.cacheImpact]))
    assert.equal(byKey.get('a'), 'dynamic-tail')
    assert.equal(byKey.get('b'), 'history-boundary')
  })

  it('focus: await-user with gates; verify for verification attention; resolve-conflict for ownership; else continue', () => {
    const gated = reduceControlSignals(emptyControlPlaneFrame(), [
      signal({ key: 'g', severity: 'blocking', requiresDecision: true }),
    ])
    assert.equal(gated.focus, 'await-user')
    const verify = reduceControlSignals(emptyControlPlaneFrame(), [
      signal({ key: 'v', kind: 'verification', severity: 'attention' }),
    ])
    assert.equal(verify.focus, 'verify')
    const conflict = reduceControlSignals(emptyControlPlaneFrame(), [
      signal({ key: 'o', kind: 'ownership', severity: 'attention' }),
    ])
    assert.equal(conflict.focus, 'resolve-conflict')
    const calm = reduceControlSignals(emptyControlPlaneFrame(), [
      signal({ key: 'i', severity: 'info' }),
    ])
    assert.equal(calm.focus, 'continue')
  })

  it('renderControlPlaneAppendix: pure, byte-stable, null when the lane is empty', () => {
    const empty = reduceControlSignals(emptyControlPlaneFrame(), [
      signal({ key: 'silent-only', severity: 'info' }),
    ])
    assert.equal(renderControlPlaneAppendix(empty), null)

    const frame = reduceControlSignals(emptyControlPlaneFrame(), [
      signal({ key: 'b', severity: 'info', routeHint: 'appendix', summary: 'fact B', evidenceKey: 'ev:b' }),
      signal({ key: 'a', severity: 'attention', routeHint: 'appendix', summary: 'fact A' }),
    ])
    const once = renderControlPlaneAppendix(frame)
    const twice = renderControlPlaneAppendix(frame)
    assert.equal(once, twice, 'identical frame must render identical bytes')
    assert.equal(once, '<control-plane>\n- [attention] fact A\n- [info] fact B (evidence: ev:b)\n</control-plane>')
    // hard cache guardrails: no timestamps / revision counters in the output
    assert.ok(!/\d{10,}|revision/.test(once ?? ''))
  })

  it('appendix and status lanes are capped (3 / 8) with stable membership', () => {
    const appendixNoise = Array.from({ length: 6 }, (_, i) =>
      signal({ key: `apx:${i}`, severity: 'info', routeHint: 'appendix' as const }))
    const statusNoise = Array.from({ length: 12 }, (_, i) =>
      signal({ key: `st:${i}`, severity: 'attention' }))
    const frame = reduceControlSignals(emptyControlPlaneFrame(), [...appendixNoise, ...statusNoise])
    assert.equal(frame.appendix.length, 3)
    assert.equal(frame.status.length, 8)
    // caps keep sorted-first entries (deterministic, key-ordered within tier)
    assert.deepEqual(frame.appendix.map(s => s.key), ['apx:0', 'apx:1', 'apx:2'])
  })
})
