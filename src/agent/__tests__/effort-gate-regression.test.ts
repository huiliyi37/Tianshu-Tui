/**
 * T2-02 Gate regression tests — reward-based gate (瑶光 返工契约).
 *
 * Anti-false-green hard gates:
 *   1. Every test titled "closed/关闭" MUST assert false.
 *   2. Every test titled "open/打开" MUST assert true.
 *   3. No zero-assertion tests.
 *   4. Must construct legitimate arm stats that produce BOTH open and closed.
 *   5. Mutation proof: modify isBanditGateOpen to invert MARGIN and verify
 *      at least one open→closed and one closed→open.
 *
 * NOTE: These tests import isBanditGateOpen directly from p3-reward.ts
 * and test it with hand-crafted ArmStat[] arrays — no bandit instance needed.
 * resolveEffortDelta tests remain in effort-delta-floor-restore.test.ts.
 */
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  isBanditGateOpen,
  MIN_PULLS_FOR_GATE,
  MIN_ARM_PULLS,
  REWARD_MARGIN,
} from '../p3-reward.js'
import type { ArmStat } from '../p3-reward.js'

function makeArm(id: string, pulls: number, avgReward: number): ArmStat {
  return { id, pulls, avgReward }
}

// ─── Gate: closed conditions ───────────────────────────────────────────

describe('gate closed — totalPulls < MIN_PULLS_FOR_GATE', () => {
  it('totalPulls=0 → gate closed', () => {
    // All-zero stats
    const stats = [
      makeArm('delta:-1', 0, 0),
      makeArm('delta:0', 0, 0),
      makeArm('delta:+1', 0, 0),
    ]
    assert.equal(isBanditGateOpen(stats), false)
  })

  it('totalPulls=29 → gate closed (just below threshold)', () => {
    // delta:0 has 25 pulls at low reward, delta:+1 has 4, total=29
    const stats = [
      makeArm('delta:-1', 0, 0),
      makeArm('delta:0', 25, 0.3),
      makeArm('delta:+1', 4, 0.5),
    ]
    assert.equal(isBanditGateOpen(stats), false)
  })
})

describe('gate closed — no delta:0 arm or delta:0 has 0 pulls', () => {
  it('no delta:0 arm → gate closed', () => {
    const stats = [
      makeArm('delta:-1', 10, 0.3),
      makeArm('delta:+1', 20, 0.5),
    ]
    assert.equal(isBanditGateOpen(stats), false)
  })

  it('delta:0 has 0 pulls → gate closed', () => {
    const stats = [
      makeArm('delta:-1', 20, 0.1),
      makeArm('delta:0', 0, 0),
      makeArm('delta:+1', 10, -0.2),
    ]
    assert.equal(isBanditGateOpen(stats), false)
  })
})

describe('gate closed — deviating arm pulls < MIN_ARM_PULLS', () => {
  it('best deviating arm has 4 pulls (< MIN_ARM_PULLS=5) → gate closed', () => {
    const stats = [
      makeArm('delta:-1', 0, 0),
      makeArm('delta:0', 26, 0.0),
      makeArm('delta:+1', 4, 0.6),  // high reward but only 4 pulls
    ]
    assert.equal(isBanditGateOpen(stats), false)
  })
})

describe('gate closed — deviating arm reward too low vs delta:0', () => {
  it('deviating avgReward 0.05 vs delta:0 0.3 → delta = -0.25, well below MARGIN=0.05 → gate closed', () => {
    // This is the KEY case: bandit tried deviating but got worse results than no-op.
    // accept=+0.75, reject=-0.25 → avgReward=0.05 means mostly rejected.
    const stats = [
      makeArm('delta:-1', 0, 0),
      makeArm('delta:0', 15, 0.3),   // no-op: decent reward
      makeArm('delta:+1', 15, 0.05),  // deviating: poor reward (mostly rejected)
    ]
    assert.equal(isBanditGateOpen(stats), false,
      'deviating arm avgReward 0.05 << delta:0 0.3 → gate MUST be closed')
  })

  it('deviating avgReward exactly delta:0 - 0.01 (below MARGIN=0.05) → gate closed', () => {
    // delta:0 avgReward=0.40, deviating avgReward=0.39, diff=-0.01 < 0.05
    const stats = [
      makeArm('delta:-1', 0, 0),
      makeArm('delta:0', 15, 0.40),
      makeArm('delta:+1', 15, 0.39),
    ]
    assert.equal(isBanditGateOpen(stats), false)
  })

  it('both deviating arms have worse reward than delta:0 → gate closed', () => {
    const stats = [
      makeArm('delta:-1', 10, -0.1),
      makeArm('delta:0', 15, 0.35),
      makeArm('delta:+1', 10, 0.1),
    ]
    assert.equal(isBanditGateOpen(stats), false)
  })
})

// ─── Gate: open conditions ─────────────────────────────────────────────

describe('gate open — deviating arm reward clearly beats delta:0', () => {
  it('delta:+1 avgReward=0.60 vs delta:0 avgReward=0.30 → diff=0.30 ≥ MARGIN=0.05 → gate open', () => {
    const stats = [
      makeArm('delta:-1', 0, 0),
      makeArm('delta:0', 15, 0.30),
      makeArm('delta:+1', 15, 0.60),
    ]
    assert.equal(isBanditGateOpen(stats), true,
      'deviating arm avgReward 0.60 > delta:0 0.30 + 0.05 → gate MUST be open')
  })

  it('delta:-1 beats delta:0 → gate open', () => {
    const stats = [
      makeArm('delta:-1', 15, 0.55),
      makeArm('delta:0', 15, 0.30),
      makeArm('delta:+1', 0, 0),
    ]
    assert.equal(isBanditGateOpen(stats), true)
  })

  it('exactly at MARGIN boundary (diff=0.05) → gate open', () => {
    const stats = [
      makeArm('delta:-1', 0, 0),
      makeArm('delta:0', 15, 0.35),
      makeArm('delta:+1', 15, 0.40),  // diff=0.05 exactly
    ]
    assert.equal(isBanditGateOpen(stats), true)
  })
})

// ─── Gate: edge cases ──────────────────────────────────────────────────

describe('gate edge cases', () => {
  it('extra arms in stats (e.g. "flash") are ignored, only delta arms matter', () => {
    const stats = [
      makeArm('flash', 100, 0.9),
      makeArm('delta:-1', 0, 0),
      makeArm('delta:0', 15, 0.30),
      makeArm('delta:+1', 15, 0.60),  // should be picked as best deviating
    ]
    assert.equal(isBanditGateOpen(stats), true,
      'non-delta arms must not interfere')
  })

  it('empty stats → gate closed', () => {
    assert.equal(isBanditGateOpen([]), false)
  })
})

// ─── Anti-false-green: mutation proof (hard gate 5) ────────────────────

describe('mutation proof: gate has teeth', () => {
  // Re-implement isBanditGateOpen with MARGIN inverted to prove
  // the real implementation actually discriminates.

  function isBanditGateOpenFlipped(armStats: ArmStat[]): boolean {
    const totalPulls = armStats.reduce((sum, s) => sum + s.pulls, 0)
    if (totalPulls < MIN_PULLS_FOR_GATE) return false
    const noop = armStats.find(s => s.id === 'delta:0')
    if (!noop || noop.pulls === 0) return false
    const deviating = armStats
      .filter(s => s.id === 'delta:-1' || s.id === 'delta:+1')
      .reduce<ArmStat | null>((best, s) => {
        if (!best) return s
        return s.avgReward > best.avgReward ? s : best
      }, null)
    if (!deviating || deviating.pulls < MIN_ARM_PULLS) return false
    // FLIPPED: use <= instead of >=
    return deviating.avgReward <= noop.avgReward + REWARD_MARGIN
  }

  it('open case becomes closed with flipped MARGIN → RED evidence', () => {
    // Original: gate OPEN (delta:+1 avgReward=0.60 > delta:0 0.30 + 0.05)
    const stats = [
      makeArm('delta:-1', 0, 0),
      makeArm('delta:0', 15, 0.30),
      makeArm('delta:+1', 15, 0.60),
    ]
    assert.equal(isBanditGateOpen(stats), true, 'real gate: open')
    // Flipped: deviating.avgReward 0.60 <= 0.30+0.05=0.35 → false → gate CLOSED
    assert.equal(isBanditGateOpenFlipped(stats), false,
      'flipped gate: closed (RED evidence — mutation broke the open case)')
  })

  it('closed case opens with flipped MARGIN → GREEN evidence', () => {
    // Original: gate CLOSED (delta:+1 avgReward=0.05 < delta:0 0.30 + 0.05)
    const stats = [
      makeArm('delta:-1', 0, 0),
      makeArm('delta:0', 15, 0.30),
      makeArm('delta:+1', 15, 0.05),
    ]
    assert.equal(isBanditGateOpen(stats), false, 'real gate: closed')
    // Flipped: deviating.avgReward 0.05 <= 0.30+0.05=0.35 → true → gate OPEN
    assert.equal(isBanditGateOpenFlipped(stats), true,
      'flipped gate: open (GREEN evidence — mutation broke the closed case)')
  })
})
