import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { ImmuneHook } from '../immune-hook.js'
import { PhysarumEngine } from '../../repo/physarum-engine.js'

describe('ImmuneHook context wiring', () => {
  it('emits prediction_error severity 0.9 when trajectoryHealth=escalate', () => {
    const hook = new ImmuneHook({ physarum: new PhysarumEngine(null as any) })
    const result = hook.run({
      toolName: 'bash', fingerprint: 'fp_x', turn: 1,
      doomLevel: 'none', trajectoryHealth: 'escalate',
    })
    const sigs = result.signals.filter(s => s.kind === 'prediction_error' && s.source === 'atropos')
    assert.equal(sigs.length, 1)
    assert.equal(sigs[0]!.severity, 0.9)
  })

  it('emits prediction_error severity 0.5 when trajectoryHealth=degrading', () => {
    const hook = new ImmuneHook({ physarum: new PhysarumEngine(null as any) })
    const result = hook.run({
      toolName: 'bash', fingerprint: 'fp_y', turn: 1,
      doomLevel: 'none', trajectoryHealth: 'degrading',
    })
    const sigs = result.signals.filter(s => s.kind === 'prediction_error' && s.source === 'atropos')
    assert.equal(sigs.length, 1)
    assert.equal(sigs[0]!.severity, 0.5)
  })

  it('does not emit prediction_error when trajectoryHealth=healthy', () => {
    const hook = new ImmuneHook({ physarum: new PhysarumEngine(null as any) })
    const result = hook.run({
      toolName: 'bash', fingerprint: 'fp_z', turn: 1,
      doomLevel: 'none', trajectoryHealth: 'healthy',
    })
    const sigs = result.signals.filter(s => s.source === 'atropos')
    assert.equal(sigs.length, 0)
  })

  it('passes tokenUsage to InnateLayer for token_spike detection', () => {
    const hook = new ImmuneHook({ physarum: new PhysarumEngine(null as any) })
    // Establish baseline at low token count
    for (let i = 0; i < 4; i++) {
      hook.run({
        toolName: 'bash', fingerprint: `fp_base_${i}`, turn: i,
        doomLevel: 'none', tokenUsage: 1000,
      })
    }
    // Spike at 5x baseline
    const result = hook.run({
      toolName: 'bash', fingerprint: 'fp_spike', turn: 5,
      doomLevel: 'none', tokenUsage: 5000,
    })
    const spikes = result.signals.filter(s => s.kind === 'token_spike')
    assert.ok(spikes.length >= 1, `expected token_spike signal, got: ${JSON.stringify(result.signals)}`)
  })
})

describe('ImmuneHook injectSignal', () => {
  it('accepts external compaction_fail signal and surfaces it via apc', () => {
    const hook = new ImmuneHook({ physarum: new PhysarumEngine(null as any) })
    hook.injectSignal({
      kind: 'compaction_fail',
      severity: 1.5,
      turn: 10,
      source: 'compaction-controller',
    })
    // Trigger evaluation by running with doom pattern matching window
    // (apc.evaluate filters signals by SIGNAL_WINDOW; injecting at turn 10 then running at turn 11 must keep it)
    const result = hook.run({
      toolName: 'bash', fingerprint: 'fp_xx', turn: 11,
      doomLevel: 'warn',
    })
    // Both pattern (doom warn) and danger signal present → activated
    assert.equal(result.activated, true, `expected activation, got signals: ${JSON.stringify(result.signals)}`)
  })

  it('injectSignal does not crash when called many times', () => {
    const hook = new ImmuneHook({ physarum: new PhysarumEngine(null as any) })
    for (let i = 0; i < 200; i++) {
      hook.injectSignal({
        kind: 'compaction_fail', severity: 0.5,
        turn: i, source: 'test',
      })
    }
    // Should not throw — apc has internal cap (MAX_SIGNALS)
    assert.ok(true)
  })
})

describe('ImmuneHook sycophancy_detected signal', () => {
  it('accepts injected sycophancy_detected signal', () => {
    const hook = new ImmuneHook({ physarum: new PhysarumEngine(null as any) })
    // Severity above APC activation threshold (1.2) so the test can verify
    // the signal is not rejected by kind. Real severity in loop.ts is 0.7.
    hook.injectSignal({
      kind: 'sycophancy_detected',
      severity: 1.5,
      turn: 5,
      source: 'sycophancy-trap',
    })
    const result = hook.run({
      toolName: 'bash', fingerprint: 'fp_syc', turn: 6,
      doomLevel: 'warn',
    })
    assert.equal(result.activated, true)
    // Signal should be in the activation evidence (apc returns recent signals)
  })
})
