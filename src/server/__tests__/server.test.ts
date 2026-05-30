import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { createRouter } from '../index.js'
import { createRoutes, type ServerState } from '../routes.js'
import { buildPromptHandler, handlePromptSSE, type PromptRouteDeps } from '../prompt-route.js'
import { SseStream } from '../sse-stream.js'
import { EventEmitter } from 'node:events'
import type { ServerResponse } from 'node:http'

// ── SseStream ──────────────────────────────────────────────

function mockRes(): ServerResponse & { chunks: string[]; ended: boolean } {
  const chunks: string[] = []
  const emitter = new EventEmitter()
  return Object.assign(emitter, {
    writeHead(_status: number, _headers?: Record<string, string>) {},
    write(data: string) { chunks.push(data) },
    end() { (this as any).ended = true },
    chunks,
    ended: false,
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
    const state: ServerState = { running: true, sessionId: 's-1' }
    const routes = createRoutes(state)
    const result = await routes['GET /status']!({})
    assert.equal(result.status, 200)
    assert.deepEqual(result.body, { running: true, sessionId: 's-1' })
  })

  it('GET /status returns null sessionId when not set', async () => {
    const state: ServerState = { running: false }
    const routes = createRoutes(state)
    const result = await routes['GET /status']!({})
    assert.deepEqual((result.body as any).sessionId, null)
  })

  it('POST /abort invokes abort callback and sets running=false', async () => {
    let aborted = false
    const state: ServerState = { running: true, abort: () => { aborted = true } }
    const routes = createRoutes(state)
    const result = await routes['POST /abort']!({})
    assert.equal(result.status, 200)
    assert.deepEqual(result.body, { aborted: true })
    assert.ok(aborted)
    assert.equal(state.running, false)
  })

  it('POST /abort works without abort callback', async () => {
    const state: ServerState = { running: true }
    const routes = createRoutes(state)
    const result = await routes['POST /abort']!({})
    assert.equal(result.status, 200)
    assert.equal(state.running, false)
  })

  it('omits POST /prompt when no deps provided', () => {
    const routes = createRoutes({ running: false })
    assert.equal(routes['POST /prompt'], undefined)
  })

  it('includes POST /prompt when deps provided', () => {
    const deps: PromptRouteDeps = {
      createAgent: () => ({ run: async () => {}, abort: () => {} }),
    }
    const routes = createRoutes({ running: false }, deps)
    assert.ok(routes['POST /prompt'])
  })
})

// ── buildPromptHandler ─────────────────────────────────────

describe('buildPromptHandler', () => {
  const deps: PromptRouteDeps = {
    createAgent: () => ({ run: async () => {}, abort: () => {} }),
  }
  const handler = buildPromptHandler(deps)

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

  it('returns 200 for valid prompt', async () => {
    const result = await handler({ prompt: 'fix the bug' })
    assert.equal(result.status, 200)
    assert.deepEqual(result.body, { accepted: true, prompt: 'fix the bug' })
  })
})

// ── handlePromptSSE ────────────────────────────────────────

describe('handlePromptSSE', () => {
  it('streams events and closes on completion', async () => {
    const res = mockRes()
    const deps: PromptRouteDeps = {
      createAgent: () => ({
        run: async (_prompt: string, callbacks: any) => {
          callbacks.onTextDelta('hello')
          callbacks.onToolUse('id-1', 'read_file', { path: '/a.ts' })
          callbacks.onToolResult('id-1', 'read_file', 'file contents')
          callbacks.onTurnComplete({ input_tokens: 100, output_tokens: 50 })
        },
        abort: () => {},
      }),
    }

    handlePromptSSE(deps, res as any, 'test prompt')

    // Wait for the async agent.run to complete
    await new Promise((r) => setTimeout(r, 50))

    const allChunks = res.chunks.join('')
    assert.ok(allChunks.includes('event: text_delta'))
    assert.ok(allChunks.includes('event: tool_use'))
    assert.ok(allChunks.includes('event: tool_result'))
    assert.ok(allChunks.includes('event: turn_complete'))
    assert.ok(res.ended)
  })

  it('sends error event and closes on agent error', async () => {
    const res = mockRes()
    const deps: PromptRouteDeps = {
      createAgent: () => ({
        run: async (_prompt: string, callbacks: any) => {
          callbacks.onError(new Error('API rate limit'))
        },
        abort: () => {},
      }),
    }

    handlePromptSSE(deps, res as any, 'test')

    await new Promise((r) => setTimeout(r, 50))

    const allChunks = res.chunks.join('')
    assert.ok(allChunks.includes('event: error'))
    assert.ok(allChunks.includes('API rate limit'))
    assert.ok(res.ended)
  })

  it('closes SSE connection when agent.run rejects', async () => {
    const res = mockRes()
    const deps: PromptRouteDeps = {
      createAgent: () => ({
        run: async () => {
          throw new Error('unexpected agent crash')
        },
        abort: () => {},
      }),
    }

    handlePromptSSE(deps, res as any, 'test')

    // Wait for the rejected promise to settle
    await new Promise((r) => setTimeout(r, 50))

    // SSE connection must be closed even when agent.run rejects
    assert.ok(res.ended, 'SSE response must be ended on agent rejection')
    // Error event should be sent
    const allChunks = res.chunks.join('')
    assert.ok(allChunks.includes('event: error'), 'error event should be sent')
    assert.ok(allChunks.includes('unexpected agent crash'), 'error message should be in payload')
  })
})
