import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { boundedSearchFetch } from '../bounded-fetch.js'

describe('boundedSearchFetch', () => {
  it('passes through a small body and preserves status', async () => {
    const fetchImpl = async () => new Response('{"a":1}', { status: 200, headers: { 'content-type': 'application/json' } })
    const bounded = boundedSearchFetch(fetchImpl, 1024)
    const res = await bounded('https://x')
    assert.equal(res.status, 200)
    assert.equal(res.ok, true)
    assert.deepEqual(await res.json(), { a: 1 })
  })

  it('preserves a non-ok status so backends can throw before reading', async () => {
    const fetchImpl = async () => new Response('nope', { status: 503 })
    const bounded = boundedSearchFetch(fetchImpl, 1024)
    const res = await bounded('https://x')
    assert.equal(res.status, 503)
    assert.equal(res.ok, false)
  })

  it('throws when the body exceeds the cap', async () => {
    const big = 'x'.repeat(2048)
    const fetchImpl = async () => new Response(big, { status: 200 })
    const bounded = boundedSearchFetch(fetchImpl, 512)
    await assert.rejects(() => bounded('https://x'), /exceeded 512-byte cap/)
  })

  it('reads a body exactly at the cap without throwing', async () => {
    const body = 'y'.repeat(512)
    const fetchImpl = async () => new Response(body, { status: 200 })
    const bounded = boundedSearchFetch(fetchImpl, 512)
    const res = await bounded('https://x')
    assert.equal(await res.text(), body)
  })

  it('passes through a null-body response (e.g. 204)', async () => {
    const fetchImpl = async () => new Response(null, { status: 204 })
    const bounded = boundedSearchFetch(fetchImpl, 512)
    const res = await bounded('https://x')
    assert.equal(res.status, 204)
  })
})
