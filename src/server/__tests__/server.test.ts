import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { createRouter } from '../index.js'
import { createRoutes, type ServerState } from '../routes.js'
import { buildPromptHandler, handlePromptSSE, type PromptRouteDeps, type PromptSessionEvent } from '../prompt-route.js'
import { SseStream } from '../sse-stream.js'
import { EventEmitter } from 'node:events'
import type { ServerResponse } from 'node:http'

// ── SseStream ──────────────────────────────────────────────

function mockRes(): ServerResponse & { chunks: string[]; ended: boolean; writableEnded: boolean; destroyed: boolean } {
  const chunks: string[] = []
  const emitter = new EventEmitter()
  return Object.assign(emitter, {
    writeHead(_status: number, _headers?: Record<string, string>) {},
    write(data: string) { chunks.push(data) },
    end() {
      ;(this as any).ended = true
      ;(this as any).writableEnded = true
    },
    chunks,
    ended: false,
    writableEnded: false,
    destroyed: false,
  }) as any
}

describe('SseStream', () => {
  it('send writes event/data SSE frames', () => {
    const res = mockRes()
    const sse = new SseStream(res)
    sse.send('text_delta', { text: 'hello' })
    assert.equal(res.chunks.length, 1)
    assert.ok(res.chunks[0]!.includes('event: text_delta'))
    assert.ok(res.chunks[0]!.includes('"text":"hello"'))
  })

  it('close sends done event and ends response', () => {
    const res = mockRes()
    const sse = new SseStream(res)
    sse.close()
    assert.ok(res.ended)
    assert.ok(res.chunks[0]!.includes('event: done'))
  })

  it('close is idempotent — second call is a no-op', () => {
    const res = mockRes()
    const sse = new SseStream(res)
    sse.close()
    const chunkCountAfterFirst = res.chunks.length
    sse.close()
    assert.equal(res.chunks.length, chunkCountAfterFirst, 'second close() must not write more data')
    assert.ok(res.ended)
  })

  it('send is a no-op after close', () => {
    const res = mockRes()
    const sse = new SseStream(res)
    sse.close()
    const chunkCount = res.chunks.length
    sse.send('text_delta', { text: 'late' })
    assert.equal(res.chunks.length, chunkCount, 'send after close must not write')
  })
})

// ── createRouter ───────────────────────────────────────────

describe('createRouter', () => {
  const routes = {
    'GET /status': () => ({ status: 200, body: { ok: true } }),
    'POST /echo': async (body: unknown) => ({ status: 200, body }),
  }
  const router = createRouter(routes)

  it('dispatches to matched route', async () => {
    const result = await router('GET', '/status', {})
    assert.equal(result.status, 200)
    assert.deepEqual(result.body, { ok: true })
  })

  it('passes body to handler', async () => {
    const result = await router('POST', '/echo', { msg: 'hi' })
    assert.equal(result.status, 200)
    assert.deepEqual(result.body, { msg: 'hi' })
  })

  it('returns 404 for unknown routes', async () => {
    const result = await router('DELETE', '/nothing', {})
    assert.equal(result.status, 404)
  })
})

// ── createRoutes ───────────────────────────────────────────

describe('createRoutes', () => {
  it('GET /status returns running state', async () => {
    const state: ServerState = { running: true, sessionId: 's-1', apiToken: 'secret' }
    const routes = createRoutes(state)
    const result = await routes['GET /status']!({}, undefined, { authorization: 'Bearer secret' })
    assert.equal(result.status, 200)
    assert.deepEqual(result.body, { running: true, sessionId: 's-1' })
  })

  it('GET /status returns null sessionId when not set', async () => {
    const state: ServerState = { running: false, apiToken: 'secret' }
    const routes = createRoutes(state)
    const result = await routes['GET /status']!({}, undefined, { authorization: 'Bearer secret' })
    assert.deepEqual((result.body as any).sessionId, null)
  })

  it('POST /abort invokes abort callback and sets running=false', async () => {
    let aborted = false
    const state: ServerState = { running: true, apiToken: 'secret', abort: () => { aborted = true } }
    const routes = createRoutes(state)
    const result = await routes['POST /abort']!({}, undefined, { authorization: 'Bearer secret' })
    assert.equal(result.status, 200)
    assert.deepEqual(result.body, { aborted: true })
    assert.ok(aborted)
    assert.equal(state.running, false)
  })

  it('POST /abort works without abort callback', async () => {
    const state: ServerState = { running: true, apiToken: 'secret' }
    const routes = createRoutes(state)
    const result = await routes['POST /abort']!({}, undefined, { authorization: 'Bearer secret' })
    assert.equal(result.status, 200)
    assert.equal(state.running, false)
  })

  it('omits POST /prompt when no deps provided', () => {
    const routes = createRoutes({ running: false })
    assert.equal(routes['POST /prompt'], undefined)
  })

  it('includes POST /prompt when deps provided', () => {
    const deps: PromptRouteDeps = { startPrompt: () => null }
    const routes = createRoutes({ running: false }, deps)
    assert.ok(routes['POST /prompt'])
  })

  it('rejects status/abort when no server token is configured', async () => {
    const routes = createRoutes({ running: true })
    const status = await routes['GET /status']!({})
    const abort = await routes['POST /abort']!({})

    assert.equal(status.status, 401)
    assert.equal(abort.status, 401)
  })

  it('rejects status/abort with wrong or missing bearer token', async () => {
    const state: ServerState = { running: true, apiToken: 'secret', abort: () => { throw new Error('should not abort') } }
    const routes = createRoutes(state)

    const missing = await routes['GET /status']!({})
    const wrong = await routes['POST /abort']!({}, undefined, { authorization: 'Bearer wrong' })

    assert.equal(missing.status, 401)
    assert.equal(wrong.status, 401)
    assert.equal(state.running, true)
  })

  it('does not accept bearer token from request body', async () => {
    const routes = createRoutes({ running: true, apiToken: 'secret' })
    const result = await routes['GET /status']!({ token: 'secret' })

    assert.equal(result.status, 401)
  })

  it('wraps /prompt with the same bearer-token auth gate and streams SSE when authorized', async () => {
    const res = mockRes()
    const fake = fakePromptSession({
      onStart: (emit) => {
        emit('text_delta', { text: 'ok' })
        emit('done', { status: 'completed' })
      },
    })
    const routes = createRoutes({ running: false, apiToken: 'secret' }, fake.deps)

    const unauthorized = await routes['POST /prompt']!({ prompt: 'x' })
    const authorized = await routes['POST /prompt']!({ prompt: 'x' }, undefined, { authorization: 'Bearer secret' }, res as any)

    assert.equal(unauthorized.status, 401)
    assert.equal(authorized.status, 200)
    assert.equal(authorized.handled, true)
    await new Promise((r) => setTimeout(r, 20))
    assert.ok(res.chunks.join('').includes('event: text_delta'))
  })
})

// ── fake session-backed prompt deps ────────────────────────

type EmitFn = (type: string, data?: Record<string, unknown>) => void

/**
 * A fake session-manager adapter matching the rebased PromptRouteDeps: the
 * route subscribes first, then calls start() — events flow to every live
 * subscriber (mirroring RuntimeSessionManager.subscribe).
 */
function fakePromptSession(opts: {
  sessionId?: string
  startOk?: boolean
  onStart?: (emit: EmitFn) => void
} = {}) {
  const listeners = new Set<(ev: PromptSessionEvent) => void>()
  let unsubscribes = 0
  const emit: EmitFn = (type, data = {}) => {
    for (const l of [...listeners]) l({ type, data })
  }
  const deps: PromptRouteDeps = {
    startPrompt: () => ({
      sessionId: opts.sessionId ?? 'sess-legacy-1',
      subscribe: (listener) => {
        listeners.add(listener)
        return () => {
          listeners.delete(listener)
          unsubscribes++
        }
      },
      start: () => {
        if (opts.startOk === false) return false
        queueMicrotask(() => opts.onStart?.(emit))
        return true
      },
    }),
  }
  return { deps, emit, listeners, get unsubscribes() { return unsubscribes } }
}

// ── buildPromptHandler ─────────────────────────────────────

describe('buildPromptHandler', () => {
  const handler = buildPromptHandler(fakePromptSession().deps)

  it('returns 400 for missing prompt', async () => {
    const result = await handler({})
    assert.equal(result.status, 400)
    assert.ok((result.body as any).error.includes('prompt'))
  })

  it('returns 400 for empty prompt', async () => {
    const result = await handler({ prompt: '   ' })
    assert.equal(result.status, 400)
  })

  it('returns 400 for non-string prompt', async () => {
    const result = await handler({ prompt: 123 })
    assert.equal(result.status, 400)
  })

  it('returns 500 for valid prompt when no ServerResponse is available', async () => {
    const result = await handler({ prompt: 'fix the bug' })
    assert.equal(result.status, 500)
    assert.ok((result.body as any).error.includes('SSE'))
  })

  it('streams SSE for valid prompt', async () => {
    const res = mockRes()
    const fake = fakePromptSession({
      onStart: (emit) => {
        emit('text_delta', { text: 'hello' })
        emit('turn_complete', { usage: { input_tokens: 2, output_tokens: 3 }, turnNumber: 1, isFinal: true })
        emit('done', { status: 'completed' })
      },
    })
    const streamingHandler = buildPromptHandler(fake.deps)

    const result = await streamingHandler({ prompt: 'fix the bug' }, undefined, undefined, res as any)
    assert.equal(result.status, 200)
    assert.equal(result.handled, true)

    await new Promise((r) => setTimeout(r, 20))
    const allChunks = res.chunks.join('')
    assert.ok(allChunks.includes('event: text_delta'))
    assert.ok(allChunks.includes('event: turn_complete'))
    assert.ok(res.ended)
  })
})

// ── handlePromptSSE ────────────────────────────────────────

describe('handlePromptSSE', () => {
  it('announces the session id first, streams events, and closes on completion', async () => {
    const res = mockRes()
    const fake = fakePromptSession({
      sessionId: 'sess-abc',
      onStart: (emit) => {
        emit('text_delta', { text: 'hello' })
        emit('tool_use', { id: 'id-1', name: 'read_file', input: { path: '/a.ts' } })
        emit('tool_result', { id: 'id-1', name: 'read_file', isError: false, result: 'file contents' })
        emit('turn_complete', { usage: { input_tokens: 100, output_tokens: 50 } })
        emit('done', { status: 'completed' })
      },
    })

    handlePromptSSE(fake.deps, res as any, 'test prompt')

    await new Promise((r) => setTimeout(r, 50))

    const allChunks = res.chunks.join('')
    assert.ok(allChunks.includes('event: session'), 'first frame must carry the session id')
    assert.ok(allChunks.includes('"sessionId":"sess-abc"'))
    assert.ok(res.chunks[0]!.includes('event: session'), 'session frame must come before any run event')
    assert.ok(allChunks.includes('event: text_delta'))
    assert.ok(allChunks.includes('event: tool_use'))
    assert.ok(allChunks.includes('event: tool_result'))
    assert.ok(allChunks.includes('event: turn_complete'))
    assert.ok(res.ended)
  })

  it('forwards error events and closes when the run finishes failed', async () => {
    const res = mockRes()
    const fake = fakePromptSession({
      onStart: (emit) => {
        emit('error', { error: 'API rate limit' })
        emit('done', { status: 'failed' })
      },
    })

    handlePromptSSE(fake.deps, res as any, 'test')

    await new Promise((r) => setTimeout(r, 50))

    const allChunks = res.chunks.join('')
    assert.ok(allChunks.includes('event: error'))
    assert.ok(allChunks.includes('API rate limit'))
    assert.ok(res.ended)
  })

  it('sends an error and closes when the run refuses to start', async () => {
    const res = mockRes()
    const fake = fakePromptSession({ startOk: false })

    handlePromptSSE(fake.deps, res as any, 'test')

    const allChunks = res.chunks.join('')
    assert.ok(allChunks.includes('event: error'))
    assert.ok(allChunks.includes('already running'))
    assert.ok(res.ended)
  })

  it('sends an error and closes when no session could be created', () => {
    const res = mockRes()
    const deps: PromptRouteDeps = { startPrompt: () => null }

    handlePromptSSE(deps, res as any, 'test')

    const allChunks = res.chunks.join('')
    assert.ok(allChunks.includes('event: error'))
    assert.ok(res.ended)
  })

  it('client disconnect stops streaming but does NOT abort the run (session semantics)', async () => {
    const res = mockRes()
    const fake = fakePromptSession()

    handlePromptSSE(fake.deps, res as any, 'test')
    await new Promise<void>((r) => queueMicrotask(r))
    assert.equal(fake.listeners.size, 1, 'route must be subscribed while the client is attached')

    res.emit('close')
    assert.equal(fake.unsubscribes, 1, 'disconnect must detach the stream listener')
    const chunksAfterClose = res.chunks.length

    // The run keeps going server-side; nothing more may reach the dead socket.
    fake.emit('text_delta', { text: 'late work continues' })
    fake.emit('done', { status: 'completed' })
    await new Promise((r) => setTimeout(r, 20))

    assert.equal(res.chunks.length, chunksAfterClose, 'late events must not write after client close')
    assert.equal(res.ended, false, 'server must not try to end an already-closed client socket')
  })

  it('normal completion detaches the close listener so a late close is a no-op', async () => {
    const res = mockRes()
    const fake = fakePromptSession({
      onStart: (emit) => {
        emit('text_delta', { text: 'done' })
        emit('done', { status: 'completed' })
      },
    })

    handlePromptSSE(fake.deps, res as any, 'test')
    await new Promise((r) => setTimeout(r, 20))

    assert.ok(res.ended)
    assert.equal(fake.unsubscribes, 1, 'completion must release the subscription')
    res.emit('close') // must not throw or double-unsubscribe
    assert.equal(fake.unsubscribes, 1)
  })
})
