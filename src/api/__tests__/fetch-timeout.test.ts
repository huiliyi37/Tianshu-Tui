import { describe, it, mock } from 'node:test'
import assert from 'node:assert/strict'
import { fetchWithTimeout } from '../fetch-timeout.js'

/** Mock fetch that never resolves but respects AbortSignal rejection. */
function hangingFetch(): typeof fetch {
  return mock.fn((_url: string | URL | Request, init?: RequestInit) =>
    new Promise<Response>((_resolve, reject) => {
      if (init?.signal?.aborted) {
        reject(new DOMException('Aborted', 'AbortError'))
        return
      }
      init?.signal?.addEventListener('abort', () => {
        reject(new DOMException('Aborted', 'AbortError'))
      }, { once: true })
    })
  ) as unknown as typeof fetch
}

describe('fetchWithTimeout', () => {
  it('returns response when fetch resolves within timeout', async () => {
    const originalFetch = globalThis.fetch
    globalThis.fetch = mock.fn(async () => new Response('ok', { status: 200 }))

    try {
      const response = await fetchWithTimeout('https://example.com/api', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: '{}',
      })
      assert.equal(response.status, 200)
    } finally {
      globalThis.fetch = originalFetch
    }
  })

  it('throws descriptive "timed out" error when server never responds', async () => {
    const originalFetch = globalThis.fetch
    globalThis.fetch = hangingFetch()

    try {
      await assert.rejects(
        () => fetchWithTimeout('https://example.com/api', {}, 500),
        (err: unknown) => {
          assert.ok(err instanceof Error, 'should be Error instance')
          assert.match(err.message, /timed out/i)
          // Must NOT be DOMException — retry engine must see this as retryable
          assert.ok(!(err instanceof DOMException), 'should not be DOMException')
          return true
        },
      )
    } finally {
      globalThis.fetch = originalFetch
    }
  })

  it('propagates AbortError when user signal aborts first', async () => {
    const originalFetch = globalThis.fetch
    globalThis.fetch = hangingFetch()

    const controller = new AbortController()
    setTimeout(() => controller.abort(), 50)

    try {
      await assert.rejects(
        () =>
          fetchWithTimeout(
            'https://example.com/api',
            { signal: controller.signal },
            10_000,
          ),
        (err: unknown) => {
          assert.ok(err instanceof DOMException, 'should be DOMException')
          assert.equal(err.name, 'AbortError')
          return true
        },
      )
    } finally {
      globalThis.fetch = originalFetch
    }
  })

  it('user abort takes priority over timeout in error', async () => {
    const originalFetch = globalThis.fetch
    globalThis.fetch = hangingFetch()

    const controller = new AbortController()
    controller.abort()

    try {
      await assert.rejects(
        () =>
          fetchWithTimeout(
            'https://example.com/api',
            { signal: controller.signal },
            500,
          ),
        (err: unknown) => {
          assert.ok(err instanceof DOMException, 'should be DOMException')
          assert.equal(err.name, 'AbortError')
          return true
        },
      )
    } finally {
      globalThis.fetch = originalFetch
    }
  })

  it('works without user signal — timeout only', async () => {
    const originalFetch = globalThis.fetch
    globalThis.fetch = hangingFetch()

    try {
      await assert.rejects(
        () => fetchWithTimeout('https://example.com/api', {}, 500),
        /timed out/i,
      )
    } finally {
      globalThis.fetch = originalFetch
    }
  })
})
