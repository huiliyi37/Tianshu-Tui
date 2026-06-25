/**
 * Track 4: 自适应流硬顶 decideStreamHardCap。
 *
 * 契约（base=10min, absolute=30min, progress window=30s）：
 * - 未到基础硬顶 → rearm 至基础硬顶
 * - 到达基础硬顶且最近 30s 有进度 → 续 60s 一档（extended）
 * - 到达基础硬顶且无近期进度 → abort
 * - 超过绝对上限 → 无条件 abort
 */

import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { decideStreamHardCap } from '../openai-client.js'

const BASE = 10 * 60_000

describe('decideStreamHardCap (Track 4)', () => {
  it('before the base cap: rearm to the base deadline', () => {
    const action = decideStreamHardCap({ now: 4 * 60_000, startedAt: 0, lastDataEventAt: 3 * 60_000, baseStreamMs: BASE })
    assert.deepEqual(action, { kind: 'rearm', rearmMs: 6 * 60_000, extended: false })
  })

  it('at the base cap with recent progress: extends in 60s slices', () => {
    const action = decideStreamHardCap({ now: BASE, startedAt: 0, lastDataEventAt: BASE - 10_000, baseStreamMs: BASE })
    assert.deepEqual(action, { kind: 'rearm', rearmMs: 60_000, extended: true })
  })

  it('at the base cap without recent progress: aborts', () => {
    const action = decideStreamHardCap({ now: BASE, startedAt: 0, lastDataEventAt: BASE - 61_000, baseStreamMs: BASE })
    assert.deepEqual(action, { kind: 'abort' })
  })

  it('past the absolute maximum: aborts even with progress', () => {
    const action = decideStreamHardCap({ now: 3 * BASE, startedAt: 0, lastDataEventAt: 3 * BASE - 1000, baseStreamMs: BASE })
    assert.deepEqual(action, { kind: 'abort' })
  })

  it('final slice is clamped to the absolute maximum', () => {
    const now = 3 * BASE - 20_000
    const action = decideStreamHardCap({ now, startedAt: 0, lastDataEventAt: now - 5_000, baseStreamMs: BASE })
    assert.deepEqual(action, { kind: 'rearm', rearmMs: 20_000, extended: true })
  })

  // Default 60s window: aborts when last data was ≥61s ago.
  it('with default 60s window: aborts when last data was 70s ago', () => {
    const action = decideStreamHardCap({ now: BASE, startedAt: 0, lastDataEventAt: BASE - 70_000, baseStreamMs: BASE })
    assert.deepEqual(action, { kind: 'abort' })
  })

  it('with 120s window: extends (not aborts) when last data was 50s ago (GLM safe)', () => {
    const action = decideStreamHardCap({ now: BASE, startedAt: 0, lastDataEventAt: BASE - 50_000, baseStreamMs: BASE }, 120_000)
    assert.deepEqual(action, { kind: 'rearm', rearmMs: 60_000, extended: true })
  })

  it('with 120s window: still aborts when last data exceeds extended window', () => {
    const action = decideStreamHardCap({ now: BASE, startedAt: 0, lastDataEventAt: BASE - 130_000, baseStreamMs: BASE }, 120_000)
    assert.deepEqual(action, { kind: 'abort' })
  })
})
