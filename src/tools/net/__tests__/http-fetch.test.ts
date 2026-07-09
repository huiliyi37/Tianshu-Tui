import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { httpFetchGuarded } from '../http-fetch.js'

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
      fetch: async () => new Response(streamOf('hello world'), {
        status: 200,
        headers: { 'content-type': 'text/plain' },
      }),
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
      fetch: async (url) => {
        calls++
        if (url === 'https://a.example.com/') {
          return new Response(null, { status: 302, headers: { location: 'https://b.example.com/secret' } })
        }
        return new Response(streamOf('final'), { status: 200 })
      },
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
        fetch: async () => new Response(null, {
          status: 302,
          headers: { location: 'http://evil.com/private' },
        }),
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
        fetch: async () => new Response(streamOf('x'.repeat(200)), {
          status: 200,
          headers: { 'content-type': 'text/plain' },
        }),
      }, { maxResponseBytes: 100 }),
      /exceeds maximum allowed size/,
    )
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
        fetch: async () => new Response(slowStream, { status: 200 }),
      }, { timeoutMs: 50 }),
      /Body read timeout/,
    )
  })
})
