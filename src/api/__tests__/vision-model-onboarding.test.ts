import { afterEach, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import {
  discoverVisionModels,
  validateVisionModel,
  vendorVisionRequestExtras,
} from '../vision-model-onboarding.js'

interface TestServer {
  baseUrl: string
  close: () => Promise<void>
}

async function startServer(handler: (req: IncomingMessage, res: ServerResponse) => void): Promise<TestServer> {
  const server = createServer(handler)
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  assert.ok(address && typeof address === 'object')
  return {
    baseUrl: `http://127.0.0.1:${address.port}/v1`,
    close: () => new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())),
  }
}

async function readJson(req: IncomingMessage): Promise<Record<string, unknown>> {
  let body = ''
  for await (const chunk of req) body += String(chunk)
  return JSON.parse(body) as Record<string, unknown>
}

describe('vision model onboarding', () => {
  let server: TestServer | undefined

  afterEach(async () => {
    await server?.close()
    server = undefined
  })

  it('offers only IDs returned by /models and never injects preset-only candidates', async () => {
    server = await startServer((req, res) => {
      assert.equal(req.url, '/v1/models')
      res.setHeader('content-type', 'application/json')
      res.end(JSON.stringify({ data: [{ id: 'custom-vision-1' }] }))
    })

    const result = await discoverVisionModels({ baseUrl: server.baseUrl, apiKey: 'sk-test' })
    assert.deepEqual(result.candidates.map(candidate => candidate.id), ['custom-vision-1'])
  })

  it('validates an unknown returned ID with exactly one image request', async () => {
    let completionCount = 0
    let completionBody: Record<string, unknown> | undefined
    server = await startServer(async (req, res) => {
      if (req.url === '/v1/models') {
        res.setHeader('content-type', 'application/json')
        res.end(JSON.stringify({ data: [{ id: 'custom-vision-1' }] }))
        return
      }
      assert.equal(req.url, '/v1/chat/completions')
      completionCount += 1
      completionBody = await readJson(req)
      res.setHeader('content-type', 'application/json')
      res.end(JSON.stringify({ choices: [{ message: { content: 'a red square' } }] }))
    })

    const result = await validateVisionModel({
      baseUrl: server.baseUrl,
      apiKey: 'sk-test',
      modelId: 'custom-vision-1',
    })

    assert.equal(result.answer, 'a red square')
    assert.equal(completionCount, 1)
    assert.equal(completionBody?.model, 'custom-vision-1')
    assert.equal(completionBody?.max_tokens, 1024)
    const messages = completionBody?.messages as Array<{ content: Array<{ type: string }> }>
    assert.ok(messages[0]?.content.some(part => part.type === 'image_url'))
  })

  it('rejects a selected ID absent from discovery before sending completion', async () => {
    let completionCount = 0
    server = await startServer((req, res) => {
      if (req.url === '/v1/models') {
        res.setHeader('content-type', 'application/json')
        res.end(JSON.stringify({ data: [{ id: 'returned-model' }] }))
        return
      }
      completionCount += 1
      res.statusCode = 500
      res.end()
    })

    await assert.rejects(
      validateVisionModel({ baseUrl: server.baseUrl, modelId: 'arbitrary-model' }),
      /not returned by \/models/,
    )
    assert.equal(completionCount, 0)
  })

  it('rejects empty assistant content', async () => {
    server = await startServer((req, res) => {
      res.setHeader('content-type', 'application/json')
      if (req.url === '/v1/models') {
        res.end(JSON.stringify({ data: [{ id: 'custom-vision-1' }] }))
      } else {
        res.end(JSON.stringify({ choices: [{ message: { content: '   ' } }] }))
      }
    })

    await assert.rejects(
      validateVisionModel({ baseUrl: server.baseUrl, modelId: 'custom-vision-1' }),
      /no answer text/,
    )
  })
})

describe('vendor vision request metadata', () => {
  it('adds Agnes thinking metadata only for official endpoints and exact chat model IDs', () => {
    assert.deepEqual(
      vendorVisionRequestExtras('https://api.agnes.ai/v1', 'agnes-2.5-flash'),
      { chat_template_kwargs: { enable_thinking: true, budget_tokens: 2048 } },
    )
    assert.deepEqual(vendorVisionRequestExtras('https://api.agnes.ai/v1', 'agnes-image-2.0-flash'), {})
    assert.deepEqual(vendorVisionRequestExtras('https://proxy.example/v1', 'agnes-2.5-flash'), {})
  })

  it('adds GLM thinking metadata only for the three exact IDs on official endpoints', () => {
    for (const modelId of ['glm-4.6v-flash', 'glm-4.1v-thinking-flash', 'glm-4v-flash']) {
      assert.deepEqual(
        vendorVisionRequestExtras('https://open.bigmodel.cn/api/paas/v4', modelId),
        { thinking: { type: 'enabled' } },
      )
    }
    assert.deepEqual(vendorVisionRequestExtras('https://open.bigmodel.cn/api/paas/v4', 'glm-4.6v'), {})
    assert.deepEqual(vendorVisionRequestExtras('https://proxy.example/v1', 'glm-4.6v-flash'), {})
  })
})
