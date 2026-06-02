import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  jitteredBackoff,
  abortableDelay,
  withStructuredRetry,
} from '../retry-engine.js'
import type { RetryInfo } from '../retry-engine.js'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Mimics the ApiError class from client.ts. */
class FakeApiError extends Error {
  constructor(
    message: string,
    public readonly status: number,
  ) {
    super(message)
    this.name = 'ApiError'
  }
}

/** Create a function that fails N times then returns `value`. */
function flakyFactory<T>(value: T, failCount: number, status = 500): () => Promise<T> {
  let calls = 0
  return async () => {
    calls++
    if (calls <= failCount) {
      throw new FakeApiError(`Server error (${status})`, status)
    }
    return value
  }
}

/** Collects RetryInfo callbacks. */
function createCollector(): { infos: RetryInfo[]; onRetry: (info: RetryInfo) => void } {
  const infos: RetryInfo[] = []
  return {
    infos,
    onRetry: (info: RetryInfo) => infos.push(info),
  }
}

// ---------------------------------------------------------------------------
// jitteredBackoff
// ---------------------------------------------------------------------------

describe('jitteredBackoff', () => {
  it('should increase monotonically across attempts', () => {
    const delays: number[] = []
    for (let i = 1; i <= 6; i++) {
      delays.push(jitteredBackoff(i, 1000, 60_000, 0))
    }
    for (let i = 1; i < delays.length; i++) {
      assert.ok(delays[i]! >= delays[i - 1]!, `delay[${i}] (${delays[i]}) < delay[${i - 1}] (${delays[i - 1]})`)
    }
  })

  it('should cap at maxDelayMs', () => {
    // With 0 jitter, the result should be exactly min(exponential, maxDelay)
    const result = jitteredBackoff(100, 1000, 5000, 0)
    assert.ok(result <= 5000, `expected <= 5000, got ${result}`)
  })

  it('should add jitter up to jitterRatio * base', () => {
    const base = 1000
    const maxDelay = 100_000
    // With full jitterRatio=1, the result can be up to 2x the exponential base
    const result = jitteredBackoff(1, base, maxDelay, 1)
    // attempt 1: exponential = 1000, capped = 1000, jitter in [0, 1000]
    // result in [1000, 2000]
    assert.ok(result >= base, `expected >= ${base}, got ${result}`)
    assert.ok(result <= base * 2, `expected <= ${base * 2}, got ${result}`)
  })
})

// ---------------------------------------------------------------------------
// abortableDelay
// ---------------------------------------------------------------------------

describe('abortableDelay', () => {
  it('should reject immediately if signal is already aborted', async () => {
    const controller = new AbortController()
    controller.abort()
    await assert.rejects(
      () => abortableDelay(1000, controller.signal),
      (err: unknown) => {
        assert.ok(err instanceof DOMException)
        assert.equal(err.name, 'AbortError')
        return true
      },
    )
  })

  it('should reject when signal aborts during delay', async () => {
    const controller = new AbortController()
    const promise = abortableDelay(10_000, controller.signal)
    // Abort shortly after starting
    setTimeout(() => controller.abort(), 10)
    await assert.rejects(
      () => promise,
      (err: unknown) => {
        assert.ok(err instanceof DOMException)
        assert.equal(err.name, 'AbortError')
        return true
      },
    )
  })
})

// ---------------------------------------------------------------------------
// withStructuredRetry
// ---------------------------------------------------------------------------

describe('withStructuredRetry', () => {
  it('should return value on first successful call', async () => {
    const result = await withStructuredRetry(async () => 'ok')
    assert.equal(result, 'ok')
  })

  it('should retry 500 errors and eventually succeed', async () => {
    const fn = flakyFactory('recovered', 2)
    const result = await withStructuredRetry(fn, undefined, { maxTotalRetries: 5 })
    assert.equal(result, 'recovered')
  })

  it('should NOT retry 401 auth errors', async () => {
    let calls = 0
    const fn = async (): Promise<string> => {
      calls++
      throw new FakeApiError('Unauthorized (401)', 401)
    }
    await assert.rejects(
      () => withStructuredRetry(fn),
      (err: unknown) => {
        assert.ok(err instanceof FakeApiError)
        assert.equal(calls, 1, 'should have called fn exactly once')
        return true
      },
    )
  })

  it('should NOT retry 413 context overflow errors', async () => {
    let calls = 0
    const fn = async (): Promise<string> => {
      calls++
      throw new FakeApiError('Request too large (413)', 413)
    }
    await assert.rejects(
      () => withStructuredRetry(fn),
      (err: unknown) => {
        assert.ok(err instanceof FakeApiError)
        assert.equal(calls, 1)
        return true
      },
    )
  })

  it('should respect maxTotalRetries limit', async () => {
    let calls = 0
    const fn = async (): Promise<string> => {
      calls++
      throw new FakeApiError('Server error (500)', 500)
    }
    // Server error has maxRetries=3 in classifier; we set maxTotalRetries=1
    await assert.rejects(
      () => withStructuredRetry(fn, undefined, { maxTotalRetries: 1 }),
    )
    // 1 initial call + 1 retry = 2 total
    assert.equal(calls, 2, `expected 2 calls, got ${calls}`)
  })

  it('should respect AbortSignal', async () => {
    const controller = new AbortController()
    let calls = 0
    const fn = async (): Promise<string> => {
      calls++
      if (calls === 1) {
        // Abort during first retry delay
        setTimeout(() => controller.abort(), 5)
      }
      throw new FakeApiError('Server error (500)', 500)
    }
    await assert.rejects(
      () => withStructuredRetry(fn, controller.signal, { maxTotalRetries: 10 }),
      (err: unknown) => {
        assert.ok(err instanceof DOMException)
        assert.equal(err.name, 'AbortError')
        return true
      },
    )
  })

  it('should call onRetry callback with classified info', async () => {
    const { infos, onRetry } = createCollector()
    const fn = flakyFactory('done', 2)
    const result = await withStructuredRetry(fn, undefined, {
      maxTotalRetries: 5,
      onRetry,
    })
    assert.equal(result, 'done')
    assert.equal(infos.length, 2, `expected 2 retries, got ${infos.length}`)
    assert.equal(infos[0]!.attempt, 1)
    assert.equal(infos[0]!.classified.category, 'server_error')
    assert.ok(infos[0]!.nextDelayMs > 0)
    assert.equal(infos[1]!.attempt, 2)
  })

  it('should succeed after multiple retries', async () => {
    // Server error has maxRetries=3; fail 3 times, succeed on 4th call
    const fn = flakyFactory('finally', 3)
    const { infos, onRetry } = createCollector()
    const result = await withStructuredRetry(fn, undefined, {
      maxTotalRetries: 5,
      onRetry,
    })
    assert.equal(result, 'finally')
    assert.equal(infos.length, 3)
  })

  it('should throw when retries are exhausted', async () => {
    // Server error maxRetries=3, set maxTotalRetries=2 so we exhaust first
    let calls = 0
    const fn = async (): Promise<string> => {
      calls++
      throw new FakeApiError('Server error (500)', 500)
    }
    await assert.rejects(
      () => withStructuredRetry(fn, undefined, { maxTotalRetries: 2 }),
      (err: unknown) => {
        assert.ok(err instanceof FakeApiError)
        return true
      },
    )
    // 1 initial + 2 retries = 3
    assert.equal(calls, 3)
  })

  it('should enforce maxTotalDurationMs global timeout', async () => {
    let calls = 0
    const fn = async (): Promise<string> => {
      calls++
      throw new FakeApiError('Server error (500)', 500)
    }
    // Set a very short global timeout (50ms) — the function will fail
    // immediately but the total elapsed time will exceed the budget quickly
    // because the retry delays accumulate.
    await assert.rejects(
      () => withStructuredRetry(fn, undefined, {
        maxTotalRetries: 100,
        maxTotalDurationMs: 50,
      }),
      (err: unknown) => {
        assert.ok(err instanceof Error)
        assert.match(err.message, /Retry budget exhausted/)
        return true
      },
    )
    // Should have called fn at least once before giving up
    assert.ok(calls >= 1, `expected at least 1 call, got ${calls}`)
  })

  it('should succeed before maxTotalDurationMs expires', async () => {
    const fn = flakyFactory('ok', 1)
    // Generous budget — should succeed before timeout
    const result = await withStructuredRetry(fn, undefined, {
      maxTotalRetries: 5,
      maxTotalDurationMs: 30_000,
    })
    assert.equal(result, 'ok')
  })
})
