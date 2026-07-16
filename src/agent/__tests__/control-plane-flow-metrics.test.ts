/**
 * Wave 5 — fixture/replay flow metrics for the control plane.
 *
 * Proves the three enable criteria on a deterministic fixture:
 *   1. ordinary (info) signals cost FEWER provider-visible bytes than the
 *      naive "inject every signal as a reminder each turn" baseline;
 *   2. decision-gate visibility never degrades — gates survive noise volume
 *      and lane caps for their entire TTL;
 *   3. unverified worker output is never upgraded to a silent pass.
 *
 * These are fixture metrics, not production telemetry — the default mode
 * stays `shadow` until real-session numbers confirm the same shape.
 */
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  emptyControlPlaneFrame,
  reduceControlSignals,
  renderControlPlaneAppendix,
  routeFor,
  tickControlSignals,
  type ControlPlaneFrame,
  type ControlSignal,
} from '../control-plane.js'
import { signalsFromVerifiedResults } from '../control-plane-adapters.js'
import { verifyWorkerEvidence } from '../worker-evidence.js'
import { BlockChargeTracker } from '../injection-meter.js'
import type { WorkerResult } from '../work-order.js'

function info(key: string, summary: string): ControlSignal {
  return {
    key, kind: 'advisory', severity: 'info', summary,
    requiresDecision: false, ttlTurns: 1, cacheImpact: 'none',
  }
}

/** Deterministic 6-turn fixture: routine facts every turn + one real gate. */
function fixtureTurn(turn: number): ControlSignal[] {
  const routine = [
    info(`advisory:delivered:self-verify`, 'advisory self-verify delivered (discipline)'),
    info(`advisory:ledger`, `advisory ledger: submitted=3 rendered=1 dropped=2 liftMuted=0`),
    info(`worker:result:wo-${turn}`, `worker wo-${turn} passed (evidence=verified)`),
    info(`compaction:amnesia:src/f${turn}.ts`, `post-compact full re-read of unchanged file src/f${turn}.ts`),
  ]
  if (turn === 3) {
    routine.push({
      key: 'worker:false-green:wo-fg', kind: 'worker', severity: 'blocking',
      summary: 'worker wo-fg claimed passed but main write-gate failed (false green, repairs=1)',
      requiresDecision: true, ttlTurns: 3, cacheImpact: 'none',
    })
  }
  return routine
}

describe('control-plane flow metrics (Wave 5 fixture/replay)', () => {
  it('ordinary signals cost fewer provider-visible bytes than per-signal injection', () => {
    let frame = emptyControlPlaneFrame()
    const tracker = new BlockChargeTracker()
    let controlPlaneBytes = 0
    let naiveBytes = 0

    for (let turn = 1; turn <= 6; turn++) {
      const incoming = fixtureTurn(turn)
      // naive baseline: every signal becomes a system-reminder append (K1 —
      // each payload's bytes are charged once at commit, every turn again).
      naiveBytes += incoming.reduce((a, s) => a + s.summary.length, 0)

      frame = reduceControlSignals({ ...frame, signals: tickControlSignals(frame.signals) }, incoming)
      // control plane: only the appendix lane reaches the provider, with
      // appendixDelta semantics (steady state = zero bytes).
      controlPlaneBytes += tracker.charge(renderControlPlaneAppendix(frame) ?? '')
    }

    assert.ok(naiveBytes > 0)
    assert.ok(
      controlPlaneBytes < naiveBytes / 4,
      `provider-visible bytes must drop by >75%: control=${controlPlaneBytes} naive=${naiveBytes}`,
    )
  })

  it('decision gates survive noise volume and lane caps for their full TTL', () => {
    let frame = emptyControlPlaneFrame()
    const gateVisibleTurns: number[] = []

    for (let turn = 1; turn <= 6; turn++) {
      const noise = Array.from({ length: 30 }, (_, i) => info(`noise:${turn}:${i}`, `routine fact ${i}`))
      frame = reduceControlSignals(
        { ...frame, signals: tickControlSignals(frame.signals) },
        [...fixtureTurn(turn), ...noise],
      )
      if (frame.decisionGates.some(s => s.key === 'worker:false-green:wo-fg')) {
        gateVisibleTurns.push(turn)
        assert.equal(frame.focus, 'await-user', 'a live gate must set focus to await-user')
      }
    }

    // Submitted at turn 3 with ttl 3 → visible turns 3,4,5 then expires.
    assert.deepEqual(gateVisibleTurns, [3, 4, 5])
  })

  it('unverified worker output is never routed silent (no upgrade path)', () => {
    const unverified: WorkerResult = {
      workOrderId: 'wo-u', status: 'passed', summary: 'patched stuff', findings: [],
      artifacts: [], changedFiles: ['src/x.ts'], risks: [], nextActions: [],
      evidenceStatus: 'unverified',
    }
    const gated = verifyWorkerEvidence(unverified, 'patcher')
    const signals = signalsFromVerifiedResults([gated])
    for (const s of signals) {
      assert.notEqual(routeFor(s), 'silent', 'unverified write output must stay master-visible')
    }
    // and it survives reduction alongside noise
    const frame = reduceControlSignals(emptyControlPlaneFrame(), [
      ...signals,
      ...Array.from({ length: 20 }, (_, i) => info(`n:${i}`, 'noise')),
    ])
    assert.ok(frame.decisionGates.some(s => s.key === 'worker:unverified:wo-u'))
  })

  it('replay determinism: the same fixture produces the same frames', () => {
    const run = (): ControlPlaneFrame[] => {
      let frame = emptyControlPlaneFrame()
      const frames: ControlPlaneFrame[] = []
      for (let turn = 1; turn <= 6; turn++) {
        frame = reduceControlSignals({ ...frame, signals: tickControlSignals(frame.signals) }, fixtureTurn(turn))
        frames.push(frame)
      }
      return frames
    }
    assert.deepEqual(run(), run())
  })
})
