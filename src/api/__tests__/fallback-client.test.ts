import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { FallbackStreamClient } from '../fallback-client.js'
import type { StreamClient, StreamCallbacks } from '../stream-client.js'
import type { OaiChatRequest } from '../oai-types.js'

function makeCallbacks(): StreamCallbacks {
  return {
    onTextDelta: () => {},
    onThinkingDelta: () => {},
    onContentBlock: () => {},
    onStopReason: () => {},
    onError: () => {},
  }
}

function makeRequest(): OaiChatRequest {
  return { model: 'test', messages: [{ role: 'user', content: 'hi' }] }
}

function makeClient(behavior: 'ok' | 'server_error' | 'auth_error'): StreamClient {
  return {
    async stream(_req: OaiChatRequest, _cb: StreamCallbacks, _signal?: AbortSignal) {
      if (behavior === 'ok') return
      if (behavior === 'server_error') {
        const err = new Error('Service Unavailable') as Error & { status: number }
        err.status = 503
        throw err
      }
      if (behavior === 'auth_error') {
        const err = new Error('Unauthorized') as Error & { status: number }
        err.status = 401
        throw err
      }
    },
  }
}

describe('FallbackStreamClient', () => {
  it('succeeds on primary — no fallback attempted', async () => {
    const primary = makeClient('ok')
    let fallbackCalled = false
    const client = new FallbackStreamClient(primary, 'main', [
      { name: 'backup', create: () => { fallbackCalled = true; return makeClient('ok') } },
    ])
    await client.stream(makeRequest(), makeCallbacks())
    assert.equal(fallbackCalled, false)
  })

  it('falls back when primary throws server_error', async () => {
    const primary = makeClient('server_error')
    const log: string[] = []
    const client = new FallbackStreamClient(
      primary, 'main',
      [{ name: 'backup', create: () => makeClient('ok') }],
      (from, to) => log.push(`${from}->${to}`),
    )
    await client.stream(makeRequest(), makeCallbacks())
    assert.deepEqual(log, ['main->backup'])
  })

  it('does NOT fall back on auth_error (non-fallbackable)', async () => {
    const primary = makeClient('auth_error')
    const client = new FallbackStreamClient(primary, 'main', [
      { name: 'backup', create: () => makeClient('ok') },
    ])
    await assert.rejects(
      () => client.stream(makeRequest(), makeCallbacks()),
      (err: unknown) => err instanceof Error && err.message === 'Unauthorized',
    )
  })

  it('tries multiple fallbacks in order', async () => {
    const primary = makeClient('server_error')
    const log: string[] = []
    const client = new FallbackStreamClient(
      primary, 'main',
      [
        { name: 'fb1', create: () => { log.push('create:fb1'); return makeClient('server_error') } },
        { name: 'fb2', create: () => { log.push('create:fb2'); return makeClient('ok') } },
      ],
      (from, to) => log.push(`${from}->${to}`),
    )
    await client.stream(makeRequest(), makeCallbacks())
    assert.deepEqual(log, ['create:fb1', 'main->fb1', 'create:fb2', 'fb1->fb2'])
  })

  it('throws last error when all fallbacks fail', async () => {
    const primary = makeClient('server_error')
    const client = new FallbackStreamClient(primary, 'main', [
      { name: 'fb1', create: () => makeClient('server_error') },
    ])
    await assert.rejects(
      () => client.stream(makeRequest(), makeCallbacks()),
      (err: unknown) => err instanceof Error && err.message === 'Service Unavailable',
    )
  })

  it('respects abort signal during fallback', async () => {
    const ac = new AbortController()
    ac.abort()
    const primary = makeClient('server_error')
    const client = new FallbackStreamClient(primary, 'main', [
      { name: 'fb', create: () => makeClient('ok') },
    ])
    await assert.rejects(
      () => client.stream(makeRequest(), makeCallbacks(), ac.signal),
    )
  })

  it('delegates setReasoningEffort to active client', () => {
    let effort = ''
    const primary: StreamClient = {
      async stream() {},
      setReasoningEffort(e: string) { effort = e },
    }
    const client = new FallbackStreamClient(primary, 'main', [])
    client.setReasoningEffort('high')
    assert.equal(effort, 'high')
  })
})
