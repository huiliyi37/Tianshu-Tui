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
