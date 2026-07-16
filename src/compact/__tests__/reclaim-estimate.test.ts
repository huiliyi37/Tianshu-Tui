import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import type { OaiMessage } from '../../api/oai-types.js'
import { estimateReclaim, shouldCommitReclaim } from '../reclaim-estimate.js'
import { deriveCompactionProfile } from '../compaction-profile.js'

const msg = (role: 'user' | 'assistant' | 'tool', content: string): OaiMessage =>
  ({ role, content, ...(role === 'tool' ? { tool_call_id: 'call_1' } : {}) }) as OaiMessage

describe('estimateReclaim', () => {
  it('plan §3.3 self-check: 40k-char tool result shrunk to 1k chars reclaims ~9750 tokens', () => {
    const before = [msg('user', 'a'), msg('assistant', 'b'), msg('tool', 'x'.repeat(40_000))]
    const after = [msg('user', 'a'), msg('assistant', 'b'), msg('tool', 'x'.repeat(1_000))]
    const est = estimateReclaim(before, after)
    // ASCII 4 chars/token: before = 10000 + 2×ceil(1/4), after = 250 + 2
    assert.equal(est.beforeTokens, 10_002)
    assert.equal(est.afterTokens, 252)
    assert.equal(est.reclaimedTokens, 9_750)
    assert.ok(Math.abs(est.reclaimRatio - 9_750 / 10_002) < 1e-9)
    assert.equal(est.changed, true)
  })

  it('plan §3.3 self-check: identical before/after → changed=false, zero reclaim', () => {
    const before = [msg('user', 'a'), msg('assistant', 'b')]
    const after = [msg('user', 'a'), msg('assistant', 'b')]
    const est = estimateReclaim(before, after)
    assert.equal(est.changed, false)
    assert.equal(est.reclaimedTokens, 0)
    assert.equal(est.reclaimRatio, 0)
  })

  it('after larger than before → negative reclaim, clamped ratio 0', () => {
    const before = [msg('user', 'a')]
    const after = [msg('user', 'a'.repeat(4_000))]
    const est = estimateReclaim(before, after)
    assert.ok(est.reclaimedTokens < 0)
    assert.equal(est.reclaimRatio, 0)
    assert.equal(est.changed, true)
  })

  it('same token estimate but different bytes still reports changed=true', () => {
    const before = [msg('user', 'aaaa')]
    const after = [msg('user', 'bbbb')]
    const est = estimateReclaim(before, after)
    assert.equal(est.reclaimedTokens, 0)
    assert.equal(est.changed, true)
  })
})

describe('shouldCommitReclaim', () => {
  const perTokenMedium = deriveCompactionProfile({ contextWindow: 256_000, billing: 'per-token', cache: 'exact-prefix' })
  const subscription = deriveCompactionProfile({ contextWindow: 256_000, billing: 'subscription', cache: 'exact-prefix' })

  it('plan §3.2 self-check: before=228000 after=227000 on 256k per-token → reject below-reclaim-floor', () => {
    const est = { beforeTokens: 228_000, afterTokens: 227_000, reclaimedTokens: 1_000, reclaimRatio: 1_000 / 228_000, changed: true }
    const verdict = shouldCommitReclaim(est, perTokenMedium, false)
    assert.equal(verdict.commit, false)
    assert.equal(verdict.reason, 'below-reclaim-floor')
  })

  it('before=228000 after=200000 (28k reclaim) → commit', () => {
    const est = { beforeTokens: 228_000, afterTokens: 200_000, reclaimedTokens: 28_000, reclaimRatio: 28_000 / 228_000, changed: true }
    const verdict = shouldCommitReclaim(est, perTokenMedium, false)
    assert.equal(verdict.commit, true)
    assert.equal(verdict.reason, 'reclaim-above-floor')
  })

  it('unchanged candidate never commits, even under force', () => {
    const est = { beforeTokens: 1_000, afterTokens: 1_000, reclaimedTokens: 0, reclaimRatio: 0, changed: false }
    assert.equal(shouldCommitReclaim(est, perTokenMedium, false).commit, false)
    assert.equal(shouldCommitReclaim(est, perTokenMedium, false).reason, 'unchanged')
    const forced = shouldCommitReclaim(est, perTokenMedium, true)
    assert.equal(forced.commit, false)
    assert.equal(forced.reason, 'unchanged')
  })

  it('afterTokens >= beforeTokens never commits without force (matrix counterexample 1)', () => {
    const est = { beforeTokens: 210_186, afterTokens: 210_698, reclaimedTokens: -512, reclaimRatio: 0, changed: true }
    const verdict = shouldCommitReclaim(est, perTokenMedium, false)
    assert.equal(verdict.commit, false)
    assert.equal(verdict.reason, 'no-reclaim')
  })

  it('force=true commits a low-reclaim changed candidate (heap emergency / ceiling)', () => {
    const est = { beforeTokens: 228_000, afterTokens: 227_000, reclaimedTokens: 1_000, reclaimRatio: 1_000 / 228_000, changed: true }
    const verdict = shouldCommitReclaim(est, perTokenMedium, true)
    assert.equal(verdict.commit, true)
    assert.equal(verdict.reason, 'forced')
  })

  it('subscription profile accepts smaller reclaims but still rejects zero reclaim', () => {
    // 5k reclaim: above subscription floor (4096 / 1%) but below per-token medium floor (8192 / 3%)
    const est = { beforeTokens: 228_000, afterTokens: 223_000, reclaimedTokens: 5_000, reclaimRatio: 5_000 / 228_000, changed: true }
    assert.equal(shouldCommitReclaim(est, subscription, false).commit, true)
    assert.equal(shouldCommitReclaim(est, perTokenMedium, false).commit, false)

    const zero = { beforeTokens: 228_000, afterTokens: 228_000, reclaimedTokens: 0, reclaimRatio: 0, changed: true }
    assert.equal(shouldCommitReclaim(zero, subscription, false).commit, false)
  })

  it('requires BOTH the token floor and the ratio floor', () => {
    // Medium per-token profile: floor 8192 tokens / 3% ratio.
    // 8.5k reclaimed out of 200k = 4.25% and above the token floor → commit.
    assert.equal(shouldCommitReclaim(
      { beforeTokens: 200_000, afterTokens: 191_500, reclaimedTokens: 8_500, reclaimRatio: 8_500 / 200_000, changed: true },
      perTokenMedium, false,
    ).commit, true)
    // Same absolute reclaim but the session over-ran the window (estimates can
    // exceed it under pressure): 8.5k out of 300k = 2.8% < 3% → reject.
    assert.equal(shouldCommitReclaim(
      { beforeTokens: 300_000, afterTokens: 291_500, reclaimedTokens: 8_500, reclaimRatio: 8_500 / 300_000, changed: true },
      perTokenMedium, false,
    ).commit, false)
  })
})
