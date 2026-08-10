import { describe, it, after } from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import { probeProvider } from '../provider-probe.js'

type Handler = (req: http.IncomingMessage, res: http.ServerResponse) => void

function startServer(handler: Handler): Promise<{ baseUrl: string; close: () => Promise<void> }> {
  return new Promise(resolve => {
    const server = http.createServer(handler)
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      const port = typeof address === 'object' && address ? address.port : 0
      resolve({
        baseUrl: `http://127.0.0.1:${port}/v1`,
        close: () => new Promise(done => server.close(() => done())),
      })
    })
  })
}

function sse(chunks: string[]): string {
  return chunks.map(c => `data: ${c}\n\n`).join('') + 'data: [DONE]\n\n'
}

describe('probeProvider', () => {
  let server: { baseUrl: string; close: () => Promise<void> } | undefined

  after(async () => {
    await server?.close()
  })

  it('fetches the model list and detects reasoning_split via a minimal completion', async () => {
    server = await startServer((req, res) => {
      if (req.url === '/v1/models') {
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ data: [{ id: 'my-model' }, { id: 'other-model' }] }))
        return
      }
      if (req.url === '/v1/chat/completions') {
        res.writeHead(200, { 'content-type': 'text/event-stream' })
        res.end(sse([
          JSON.stringify({ choices: [{ delta: { reasoning_content: 'thinking...' } }] }),
          JSON.stringify({ choices: [{ delta: { content: 'hi' }, finish_reason: 'stop' }] }),
        ]))
        return
      }
      res.writeHead(404).end()
    })

    const report = await probeProvider({ baseUrl: server.baseUrl, apiKey: 'sk-test' })
    assert.deepEqual(report.models, ['my-model', 'other-model'])
    assert.equal(report.modelsOk, true)
    assert.equal(report.completionOk, true)
    assert.equal(report.hints.reasoningSplit, true)
    assert.ok(typeof report.latencyMs === 'number')
    assert.deepEqual(report.errors, [])
    await server.close()
    server = undefined
  })

  it('classifies a 401 on /models and degrades instead of throwing', async () => {
    server = await startServer((_req, res) => {
      res.writeHead(401, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ error: 'invalid api key' }))
    })

    const report = await probeProvider({ baseUrl: server.baseUrl, apiKey: 'bad', skipCompletion: true })
    assert.equal(report.modelsOk, false)
    assert.deepEqual(report.models, [])
    assert.ok(report.errors.some(e => e.includes('Authentication failed')), report.errors.join('; '))
    await server.close()
    server = undefined
  })

  it('classifies quota exhaustion (FreeTierOnly 403) as a billing problem, not auth', async () => {
    server = await startServer((_req, res) => {
      res.writeHead(403, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ code: 'AllocationQuota.FreeTierOnly', message: 'Free quota exhausted. To continue accessing the model on a paid basis, please add funds.' }))
    })

    const report = await probeProvider({ baseUrl: server.baseUrl, apiKey: 'sk-ok', skipCompletion: true })
    assert.equal(report.modelsOk, false)
    assert.ok(report.errors.some(e => e.includes('Quota/billing problem')), report.errors.join('; '))
    assert.ok(!report.errors.some(e => e.includes('Authentication failed')), report.errors.join('; '))
    await server.close()
    server = undefined
  })

  it('flags a non-SSE 200 completion with missing-/v1 guidance', async () => {
    server = await startServer((req, res) => {
      if (req.url === '/v1/models') {
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ data: [{ id: 'm' }] }))
        return
      }
      res.writeHead(200, { 'content-type': 'text/html' })
      res.end('<html>not an api</html>')
    })

    const report = await probeProvider({ baseUrl: server.baseUrl })
    assert.equal(report.modelsOk, true)
    assert.equal(report.completionOk, false)
    assert.ok(report.errors.some(e => e.includes('SSE')), report.errors.join('; '))
    await server.close()
    server = undefined
  })

  it('404 on completion suggests checking the model id / path', async () => {
    server = await startServer((req, res) => {
      if (req.url === '/v1/models') {
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ data: [] }))
        return
      }
      res.writeHead(404).end('{"error":"not found"}')
    })

    const report = await probeProvider({ baseUrl: server.baseUrl, probeModel: 'ghost-model' })
    assert.equal(report.completionOk, false)
    assert.ok(report.errors.some(e => e.includes('404')), report.errors.join('; '))
    await server.close()
    server = undefined
  })

  it('prefers a discovered model over the suggested probeModel for completion', async () => {
    let probedModel = ''
    server = await startServer((req, res) => {
      if (req.url === '/v1/models') {
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ data: [{ id: 'workspace-model' }] }))
        return
      }
      let body = ''
      req.on('data', chunk => { body += chunk })
      req.on('end', () => {
        probedModel = (JSON.parse(body) as { model: string }).model
        res.writeHead(200, { 'content-type': 'text/event-stream' })
        res.end('data: {"choices":[{"delta":{"content":"ok"}}]}\n\ndata: [DONE]\n\n')
      })
    })

    const report = await probeProvider({ baseUrl: server.baseUrl, probeModel: 'template-default' })
    assert.equal(report.completionOk, true)
    assert.equal(probedModel, 'workspace-model')
    await server.close()
    server = undefined
  })

  it('uses the suggested probeModel when it exists in the discovered list', async () => {
    let probedModel = ''
    server = await startServer((req, res) => {
      if (req.url === '/v1/models') {
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ data: [{ id: 'expensive-flagship' }, { id: 'template-default' }] }))
        return
      }
      let body = ''
      req.on('data', chunk => { body += chunk })
      req.on('end', () => {
        probedModel = (JSON.parse(body) as { model: string }).model
        res.writeHead(200, { 'content-type': 'text/event-stream' })
        res.end('data: {"choices":[{"delta":{"content":"ok"}}]}\n\ndata: [DONE]\n\n')
      })
    })

    const report = await probeProvider({ baseUrl: server.baseUrl, probeModel: 'template-default' })
    assert.equal(report.completionOk, true)
    assert.equal(probedModel, 'template-default')
    await server.close()
    server = undefined
  })

  it('normalizes a pasted full chat URL instead of double-appending paths', async () => {
    const hits: string[] = []
    server = await startServer((req, res) => {
      hits.push(req.url ?? '')
      if (req.url === '/v1/models') {
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ data: [{ id: 'm1' }] }))
        return
      }
      res.writeHead(200, { 'content-type': 'text/event-stream' })
      res.end(sse([JSON.stringify({ choices: [{ delta: { content: 'ok' } }] })]))
    })

    const report = await probeProvider({ baseUrl: `${server.baseUrl}/chat/completions` })
    assert.equal(report.modelsOk, true)
    assert.equal(report.completionOk, true)
    assert.deepEqual(hits, ['/v1/models', '/v1/chat/completions'])
    await server.close()
    server = undefined
  })

  it('version-less base (oneapi-style) gets /v1 inserted before the paths', async () => {
    const hits: string[] = []
    server = await startServer((req, res) => {
      hits.push(req.url ?? '')
      if (req.url === '/v1/models') {
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ data: [{ id: 'm1' }] }))
        return
      }
      res.writeHead(200, { 'content-type': 'text/event-stream' })
      res.end(sse([JSON.stringify({ choices: [{ delta: { content: 'ok' } }] })]))
    })

    // startServer's baseUrl ends in /v1 — strip it to simulate a bare /api base.
    const bareBase = server.baseUrl.replace(/\/v1$/, '')
    const report = await probeProvider({ baseUrl: bareBase })
    assert.equal(report.modelsOk, true)
    assert.equal(report.completionOk, true)
    assert.deepEqual(hits, ['/v1/models', '/v1/chat/completions'])
    await server.close()
    server = undefined
  })

  it('skipCompletion never touches the completion endpoint', async () => {
    let completionHits = 0
    server = await startServer((req, res) => {
      if (req.url === '/v1/models') {
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ data: [{ id: 'only-model' }] }))
        return
      }
      completionHits++
      res.writeHead(200).end()
    })

    const report = await probeProvider({ baseUrl: server.baseUrl, skipCompletion: true })
    assert.deepEqual(report.models, ['only-model'])
    assert.equal(report.completionOk, false)
    assert.equal(completionHits, 0)
    await server.close()
    server = undefined
  })

  it('degrades gracefully when the endpoint refuses the connection', async () => {
    // Reserve a port and close it immediately → guaranteed ECONNREFUSED.
    const placeholder = await startServer((_req, res) => res.end())
    const deadUrl = placeholder.baseUrl
    await placeholder.close()

    const report = await probeProvider({ baseUrl: deadUrl, timeoutMs: 3_000 })
    assert.equal(report.modelsOk, false)
    assert.equal(report.completionOk, false)
    assert.ok(report.errors.length >= 1)
  })

  it('probes the anthropic messages endpoint with x-api-key for protocol anthropic', async () => {
    let sawApiKey = false
    server = await startServer((req, res) => {
      if (req.url === '/v1/models') {
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ data: [{ id: 'claude-x' }] }))
        return
      }
      if (req.url === '/v1/messages') {
        sawApiKey = req.headers['x-api-key'] === 'sk-ant'
        res.writeHead(200, { 'content-type': 'text/event-stream' })
        res.end('event: message_start\ndata: {"type":"message_start"}\n\n')
        return
      }
      res.writeHead(404).end()
    })

    // baseUrl for anthropic clients excludes /v1 (the client appends it).
    const baseUrl = server.baseUrl.replace(/\/v1$/, '')
    const report = await probeProvider({ baseUrl, apiKey: 'sk-ant', protocol: 'anthropic' })
    assert.equal(report.completionOk, true)
    assert.equal(sawApiKey, true)
    await server.close()
    server = undefined
  })
})
