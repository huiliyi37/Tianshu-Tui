import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { createRouter, type RouteHandler } from '../server/index.js'

describe('createRouter', () => {
  it('routes GET /status to handler', async () => {
    const handler: RouteHandler = (_req) => ({ status: 200, body: { ok: true } })
    const router = createRouter({ 'GET /status': handler })
    const result = await router('GET', '/status', {})
    assert.equal(result.status, 200)
    assert.deepEqual(result.body, { ok: true })
  })

  it('returns 404 for unknown routes', async () => {
    const router = createRouter({})
    const result = await router('GET', '/nope', {})
    assert.equal(result.status, 404)
  })

  it('handles async handlers', async () => {
    const handler: RouteHandler = async (_body) => {
      return { status: 200, body: { data: 'async' } }
    }
    const router = createRouter({ 'POST /prompt': handler })
    const result = await router('POST', '/prompt', { prompt: 'hello' })
    assert.equal(result.status, 200)
    assert.deepEqual(result.body, { data: 'async' })
  })
})
