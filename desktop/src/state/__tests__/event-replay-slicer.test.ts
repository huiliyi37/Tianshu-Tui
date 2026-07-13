import { test } from 'node:test'
import assert from 'node:assert/strict'
import { eventReducer, initialEventState } from '../event-reducer'
import type { EventViewState } from '../event-reducer'
import type { SessionEvent } from '../../runtime/types'

test('production replay slicer drains bounded chunks to the one-shot state', async () => {
  let foldEventSlice: undefined | ((
    state: EventViewState,
    events: readonly SessionEvent[],
  ) => { state: EventViewState; consumed: number; durationMs: number }
  )
  try {
    const module = await import('../event-replay-slicer')
    foldEventSlice = module.foldEventSlice
  } catch {
    // Assertion below gives a focused RED failure while the helper is absent.
  }
  assert.equal(typeof foldEventSlice, 'function', 'production must export the slicer used by the fixture')
  if (!foldEventSlice) return

  const events = Array.from({ length: 1000 }, (_, index) => ({
    seq: index + 1,
    ts: index,
    type: 'text_delta',
    data: { text: 'x' },
  } as SessionEvent))
  let state = initialEventState
  let offset = 0
  while (offset < events.length) {
    const slice = foldEventSlice(state, events.slice(offset))
    assert.ok(slice.consumed > 0 && slice.consumed <= 400)
    assert.ok(slice.durationMs >= 0)
    state = slice.state
    offset += slice.consumed
  }

  const oneShot = eventReducer(initialEventState, { type: 'events', events })
  assert.equal(state.lastSeq, oneShot.lastSeq)
  assert.deepEqual(state.blocks, oneShot.blocks)
})

test('replay slicer checks the 6ms budget after at most 10 events', async () => {
  const { foldEventSlice } = await import('../event-replay-slicer')
  const events = Array.from({ length: 100 }, (_, index) => ({
    seq: index + 1,
    ts: index,
    type: 'text_delta',
    data: { text: 'x' },
  } as SessionEvent))
  let clockReads = 0
  const slice = foldEventSlice(initialEventState, events, () => {
    clockReads++
    return clockReads === 1 ? 0 : 10
  })

  assert.equal(slice.consumed, 10, 'an over-budget reducer chunk must overshoot by no more than 10 events')
  assert.equal(slice.durationMs, 10)
})
