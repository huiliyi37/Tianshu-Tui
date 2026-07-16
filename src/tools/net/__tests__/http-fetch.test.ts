import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { buildPinnedLookup, httpFetchGuarded, type FetchLike } from '../http-fetch.js'
import { SSRFError } from '../ssrf.js'

/** Helper: wrap a DOM-Response-returning mock into the undici FetchLike type.
 *  At runtime undici Response and global Response are structurally identical. */
const mockFetch = (fn: (url: string) => Promise<Response>): FetchLike =>
  fn as unknown as FetchLike

function publicLookup() {
  return async (hostname: string) => ({ address: '93.184.216.34' })
}

function streamOf(text: string): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder()
  return new ReadableStream({
    start(controller) {
      controller.enqueue(encoder.encode(text))
      controller.close()
    },
  })
}

describe('httpFetchGuarded', () => {
  it('returns body bytes for a simple 200', async () => {
    const result = await httpFetchGuarded('https://example.com/page', {
      lookup: publicLookup(),
      fetch: mockFetch(async () => new Response(streamOf('hello world'), {
        status: 200,
        headers: { 'content-type': 'text/plain' },
      })),
    })

    assert.equal(result.status, 200)
    assert.equal(result.finalUrl, 'https://example.com/page')
    assert.equal(result.contentType, 'text/plain')
    assert.equal(new TextDecoder().decode(result.bytes), 'hello world')
  })

  it('follows manual redirects to public URLs', async () => {
    let calls = 0
    const result = await httpFetchGuarded('https://a.example.com', {
      lookup: async () => ({ address: '93.184.216.34' }),
      fetch: mockFetch(async (url) => {
        calls++
        if (url === 'https://a.example.com/') {
          return new Response(null, { status: 302, headers: { location: 'https://b.example.com/secret' } })
        }
        return new Response(streamOf('final'), { status: 200 })
      }),
    })

    assert.equal(result.status, 200)
    assert.equal(result.finalUrl, 'https://b.example.com/secret')
    assert.equal(calls, 2)
    assert.equal(new TextDecoder().decode(result.bytes), 'final')
  })

  it('rejects redirect to private IP', async () => {
    await assert.rejects(
      async () => httpFetchGuarded('https://public.example.com', {
        lookup: async (hostname) => {
          if (hostname === 'evil.com') return { address: '10.0.0.1' }
          return { address: '93.184.216.34' }
        },
        fetch: mockFetch(async () => new Response(null, {
          status: 302,
          headers: { location: 'http://evil.com/private' },
        })),
      }),
      /Access denied.*10\.0\.0\.1/,
    )
  })

  it('rejects unsupported protocol', async () => {
    await assert.rejects(
      async () => httpFetchGuarded('file:///etc/passwd', { lookup: publicLookup() }),
      /Unsupported protocol/,
    )
  })

  it('enforces maxResponseBytes and cancels the reader', async () => {
    await assert.rejects(
      async () => httpFetchGuarded('https://big.example.com', {
        lookup: publicLookup(),
        fetch: mockFetch(async () => new Response(streamOf('x'.repeat(200)), {
          status: 200,
          headers: { 'content-type': 'text/plain' },
        })),
      }, { maxResponseBytes: 100 }),
      /exceeds maximum allowed size/,
    )
  })

  it('pins the connection to the validated IP regardless of the hostname asked', () => {
    // The lookup must return the pre-validated address, not re-resolve the name
    // — this is what closes the DNS-rebinding window.
    const lookup = buildPinnedLookup('93.184.216.34', 4)
    let seen: { address?: string; family?: number } = {}
    lookup('attacker-controlled.example.com', {}, (err, address, family) => {
      assert.equal(err, null)
      seen = { address: address as string, family }
    })
    assert.equal(seen.address, '93.184.216.34')
    assert.equal(seen.family, 4)
  })

  it('returns the address-list form when the connector asks for all records', () => {
    const lookup = buildPinnedLookup('2001:4860:4860::8888', 6)
    let list: { address: string; family: number }[] = []
    lookup('example.com', { all: true }, (err, addresses) => {
      assert.equal(err, null)
      list = addresses as { address: string; family: number }[]
    })
    assert.deepEqual(list, [{ address: '2001:4860:4860::8888', family: 6 }])
  })

  it('refuses to hand a private IP to the socket layer (defence in depth)', () => {
    const lookup = buildPinnedLookup('10.0.0.1', 4)
    let captured: unknown
    lookup('rebind.example.com', {}, (err) => { captured = err })
    assert.ok(captured instanceof SSRFError)
  })

  it('aborts on body read timeout', async () => {
    const slowStream = new ReadableStream<Uint8Array>({
      start(_controller) {
        // never closes
      },
    })

    await assert.rejects(
      async () => httpFetchGuarded('https://slow.example.com', {
        lookup: publicLookup(),
        fetch: mockFetch(async () => new Response(slowStream, { status: 200 })),
      }, { timeoutMs: 50 }),
      /Body read timeout/,
    )
  })
})
