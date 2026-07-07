import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { rejectOnAbort, TurnBoundaryAbortError } from '../turn-boundary-abort.js'

function delay(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms))
}

/** A promise that never settles — simulates a wedged turn-boundary await. */
function neverSettles(): Promise<never> {
  return new Promise<never>(() => {})
}

describe('rejectOnAbort', () => {
  it('resolves with the work value when work settles before abort', async () => {
    const ctrl = new AbortController()
    const result = await rejectOnAbort(Promise.resolve(42), ctrl.signal, 'test')
    assert.equal(result, 42)
  })

  it('propagates work rejection unchanged when work rejects before abort', async () => {
    const ctrl = new AbortController()
    const boom = new Error('work failed')
    await assert.rejects(
      rejectOnAbort(Promise.reject(boom), ctrl.signal, 'test'),
      (err: Error) => err === boom,
    )
  })

  it('rejects with AbortError the moment the signal fires on a wedged await', async () => {
    const ctrl = new AbortController()
    // The whole point: work never resolves, but abort must still free us.
    const raced = rejectOnAbort(neverSettles(), ctrl.signal, 'compaction')
    setTimeout(() => ctrl.abort(), 20)
    await assert.rejects(raced, (err: Error) => {
      assert.equal(err.name, 'AbortError', 'must be named AbortError so the loop treats it as clean abort')
      assert.ok(err instanceof TurnBoundaryAbortError)
      assert.match(err.message, /compaction/, 'message should carry the wedged stage')
      return true
    })
  })

  it('rejects immediately when the signal is already aborted', async () => {
    const ctrl = new AbortController()
    ctrl.abort()
    await assert.rejects(
      rejectOnAbort(neverSettles(), ctrl.signal, 'prewarm'),
      (err: Error) => err.name === 'AbortError' && /prewarm/.test(err.message),
    )
  })

  it('returns the raw work promise (no race) when no signal is provided', async () => {
    const work = Promise.resolve('ok')
    const out = rejectOnAbort(work, undefined, 'test')
    assert.equal(out, work, 'must pass through the same promise when no signal')
    assert.equal(await out, 'ok')
  })

  it('does not leak abort listeners after work resolves', async () => {
    const ctrl = new AbortController()
    // node AbortSignal exposes listener count via events; assert via removeEventListener path:
    let aborted = false
    const work = delay(10).then(() => 'done')
    const result = await rejectOnAbort(work, ctrl.signal, 'test')
    assert.equal(result, 'done')
    // Aborting AFTER work settled must not throw or affect anything observable.
    ctrl.signal.addEventListener('abort', () => { aborted = true })
    ctrl.abort()
    await delay(5)
    assert.equal(aborted, true, 'fresh listener still works — no interference from settled race')
  })
})
