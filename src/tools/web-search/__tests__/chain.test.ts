import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { runBackendChain } from '../chain.js'
import type { SearchBackend, SearchResult } from '../types.js'

function backend(
  name: string,
  behavior: () => Promise<SearchResult[]>,
  available = true,
): SearchBackend & { calls: number } {
  return {
    name,
    calls: 0,
    isAvailable: () => available,
    async search() {
      ;(this as { calls: number }).calls++
      return behavior()
    },
  }
}

const hit: SearchResult[] = [{ title: 't', url: 'https://x', snippet: 's' }]

describe('runBackendChain', () => {
  it('returns the first non-empty backend and short-circuits the rest', async () => {
    const first = backend('brave', async () => hit)
    const second = backend('ddg', async () => hit)
    const out = await runBackendChain([first, second], 'q', 10, 1000)
    assert.equal(out.backend, 'brave')
    assert.deepEqual(out.results, hit)
    assert.equal(first.calls, 1)
    assert.equal(second.calls, 0, 'second backend must not be called after a hit')
  })

  it('falls through on empty results and records them', async () => {
    const first = backend('brave', async () => [])
    const second = backend('ddg', async () => hit)
    const out = await runBackendChain([first, second], 'q', 10, 1000)
    assert.equal(out.backend, 'ddg')
    assert.equal(second.calls, 1)
    assert.deepEqual(out.errors, [{ backend: 'brave', message: 'no results' }])
  })

  it('falls through on a thrown error and records the message', async () => {
    const first = backend('brave', async () => { throw new Error('HTTP 429') })
    const second = backend('ddg', async () => hit)
    const out = await runBackendChain([first, second], 'q', 10, 1000)
    assert.equal(out.backend, 'ddg')
    assert.equal(out.errors[0]!.backend, 'brave')
    assert.match(out.errors[0]!.message, /HTTP 429/)
  })

  it('skips unavailable backends without recording an error', async () => {
    const skipped = backend('brave', async () => hit, false)
    const used = backend('ddg', async () => hit)
    const out = await runBackendChain([skipped, used], 'q', 10, 1000)
    assert.equal(out.backend, 'ddg')
    assert.equal(skipped.calls, 0)
    assert.equal(out.errors.length, 0)
  })

  it('returns null backend with aggregated errors when all fail', async () => {
    const a = backend('brave', async () => { throw new Error('boom') })
    const b = backend('ddg', async () => [])
    const out = await runBackendChain([a, b], 'q', 10, 1000)
    assert.equal(out.backend, null)
    assert.deepEqual(out.results, [])
    assert.equal(out.errors.length, 2)
  })
})
