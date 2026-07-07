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

  // 4e1aaa21 post-mortem regression: the first-byte timeout must be DISARMED
  // once headers arrive. A body stream that takes longer than timeoutMs must
  // NOT be aborted mid-stream ("The operation was aborted due to timeout").
  it('does not abort body streaming that outlives the first-byte timeout', async () => {
    const originalFetch = globalThis.fetch

    // Mock fetch: headers resolve immediately; body emits 3 chunks over ~300ms.
    // The stream errors if the request signal aborts — mirroring undici behavior.
    globalThis.fetch = mock.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      const signal = init?.signal
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          const abortErr = new DOMException('The operation was aborted due to timeout', 'TimeoutError')
          if (signal?.aborted) {
            controller.error(abortErr)
            return
          }
          signal?.addEventListener('abort', () => {
            try { controller.error(signal.reason ?? abortErr) } catch { /* already closed */ }
          }, { once: true })
          let sent = 0
          const tick = setInterval(() => {
            sent++
            controller.enqueue(new TextEncoder().encode(`chunk${sent}\n`))
            if (sent >= 3) {
              clearInterval(tick)
              try { controller.close() } catch { /* aborted */ }
            }
          }, 100)
        },
      })
      return new Response(body, { status: 200 })
    }) as unknown as typeof fetch

    try {
      // timeoutMs (50ms) far shorter than body duration (~300ms)
      const response = await fetchWithTimeout('https://example.com/api', {}, 50)
      assert.equal(response.status, 200)

      const reader = response.body!.getReader()
      const decoder = new TextDecoder()
      let received = ''
      for (;;) {
        const { done, value } = await reader.read()
        if (done) break
        received += decoder.decode(value, { stream: true })
      }
      assert.match(received, /chunk1[\s\S]*chunk2[\s\S]*chunk3/, 'all chunks must arrive after timeout window elapsed')
    } finally {
      globalThis.fetch = originalFetch
    }
  })

  // undici throws `TypeError: fetch failed` with the real network failure in
  // err.cause. The wrapper must surface that detail in the message — a bare
  // "fetch failed" on the TUI/desktop error line is undiagnosable.
  it('enriches "fetch failed" with the buried cause detail', async () => {
    const originalFetch = globalThis.fetch
    const cause = Object.assign(new Error('connect ECONNREFUSED 104.18.27.90:443'), { code: 'ECONNREFUSED' })
    globalThis.fetch = mock.fn(async () => {
      throw new TypeError('fetch failed', { cause })
    }) as unknown as typeof fetch

    try {
      await assert.rejects(
        () => fetchWithTimeout('https://example.com/api', {}),
        (err: unknown) => {
          assert.ok(err instanceof Error)
          assert.match(err.message, /fetch failed: connect ECONNREFUSED 104\.18\.27\.90:443/)
          // Original error preserved as cause for classifier/logs
          assert.ok((err.cause as Error).message === 'fetch failed')
          return true
        },
      )
    } finally {
      globalThis.fetch = originalFetch
    }
  })

  it('passes through "fetch failed" without cause unchanged', async () => {
    const originalFetch = globalThis.fetch
    globalThis.fetch = mock.fn(async () => {
      throw new TypeError('fetch failed')
    }) as unknown as typeof fetch

    try {
      await assert.rejects(
        () => fetchWithTimeout('https://example.com/api', {}),
        (err: unknown) => {
          assert.equal((err as Error).message, 'fetch failed')
          return true
        },
      )
    } finally {
      globalThis.fetch = originalFetch
    }
  })

  it('user signal still aborts body streaming after headers (lifecycle abort preserved)', async () => {
    const originalFetch = globalThis.fetch
    const controller = new AbortController()

    globalThis.fetch = mock.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      const signal = init?.signal
      const body = new ReadableStream<Uint8Array>({
        start(streamController) {
          signal?.addEventListener('abort', () => {
            try { streamController.error(new DOMException('Aborted', 'AbortError')) } catch { /* closed */ }
          }, { once: true })
          // Emits nothing — waits to be aborted.
        },
      })
      return new Response(body, { status: 200 })
    }) as unknown as typeof fetch

    try {
      const response = await fetchWithTimeout('https://example.com/api', { signal: controller.signal }, 50)
      const reader = response.body!.getReader()
      setTimeout(() => controller.abort(), 100)
      await assert.rejects(
        () => reader.read(),
        (err: unknown) => {
          assert.equal((err as Error).name, 'AbortError')
          return true
        },
      )
    } finally {
      globalThis.fetch = originalFetch
    }
  })
})
