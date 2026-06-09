import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { pickWaitingIndicator } from '../waiting-indicator.js'

describe('pickWaitingIndicator (single waiting-indicator invariant)', () => {
  it('returns none when not streaming', () => {
    assert.equal(
      pickWaitingIndicator({ isStreaming: false, hasText: false, hasHeartbeat: false, hasTools: false, hasThinking: false }),
      'none',
    )
  })

  it('returns stream as the fallback before any heartbeat label', () => {
    assert.equal(
      pickWaitingIndicator({ isStreaming: true, hasText: false, hasHeartbeat: false, hasTools: false, hasThinking: false }),
      'stream',
    )
  })

  it('returns heartbeat once a phase label exists (more informative)', () => {
    assert.equal(
      pickWaitingIndicator({ isStreaming: true, hasText: false, hasHeartbeat: true, hasTools: false, hasThinking: false }),
      'heartbeat',
    )
  })

  // The core regression: during first-token wait both StreamOutput's empty
  // state and the heartbeat box used to render together → stacked ghost rows.
  // The picker must never authorize both at once.
  it('never returns both — at most one indicator across the full state matrix', () => {
    for (const isStreaming of [false, true]) {
      for (const hasText of [false, true]) {
        for (const hasHeartbeat of [false, true]) {
          for (const hasTools of [false, true]) {
            for (const hasThinking of [false, true]) {
              const r = pickWaitingIndicator({ isStreaming, hasText, hasHeartbeat, hasTools, hasThinking })
              assert.ok(r === 'stream' || r === 'heartbeat' || r === 'none', `unexpected value ${r}`)
              // 'stream' and 'heartbeat' are mutually exclusive by construction —
              // a single return value can never be both.
            }
          }
        }
      }
    }
  })

  it('yields to concrete content (text/tools/thinking) — no waiting indicator', () => {
    assert.equal(
      pickWaitingIndicator({ isStreaming: true, hasText: true, hasHeartbeat: true, hasTools: false, hasThinking: false }),
      'none',
    )
    assert.equal(
      pickWaitingIndicator({ isStreaming: true, hasText: false, hasHeartbeat: true, hasTools: true, hasThinking: false }),
      'none',
    )
    assert.equal(
      pickWaitingIndicator({ isStreaming: true, hasText: false, hasHeartbeat: true, hasTools: false, hasThinking: true }),
      'none',
    )
  })
})
