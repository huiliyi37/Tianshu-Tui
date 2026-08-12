/**
 * Wave 4 — runtime error-message snapshots.
 *
 * Exact strings users see for the common onboarding misconfigurations:
 * 401 (names the key's env var), 404 (points at `rivet provider models`),
 * and a 200 that is not an SSE stream (content-type gate → non-retryable).
 */
import { describe, it, after } from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import { parseOpenAIError } from '../openai-client.js'
import { OpenAIClient } from '../openai-client.js'
import { classifyApiError } from '../error-classifier.js'

describe('parseOpenAIError status hints', () => {
  it('401 names the API-key environment variable when known', () => {
    const out = parseOpenAIError(
      401,
      JSON.stringify({ error: { message: 'Invalid API key' } }),
      { providerName: 'deepseek', baseUrl: 'https://api.deepseek.com/v1', apiKeyEnv: 'DEEPSEEK_API_KEY' },
    )
    assert.equal(
      out,
      'OpenAI API error (HTTP 401): Invalid API key'
      + '\n提示：鉴权失败（HTTP 401）——请检查环境变量 DEEPSEEK_API_KEY 是否已导出且未过期，或用 /connect 重新配置。',
    )
  })

  it('401 without apiKeyEnv falls back to a generic key hint', () => {
    const out = parseOpenAIError(401, 'unauthorized', { providerName: 'custom' })
    assert.equal(
      out,
      'OpenAI API error (HTTP 401): unauthorized'
      + '\n提示：鉴权失败（HTTP 401）——请检查 API key 是否正确，或用 /connect 重新配置。',
    )
  })

  it('404 suggests verifying the model id via `rivet provider models`', () => {
    const out = parseOpenAIError(404, JSON.stringify({ error: { message: 'model not found' } }))
    assert.equal(
      out,
      'OpenAI API error (HTTP 404): model not found'
      + '\n提示：404 通常是模型 id 拼错或端点路径不对——运行 `rivet provider models <provider>` 核对端点实际提供的模型 id。',
    )
  })

  it('other statuses get no status hint (message unchanged)', () => {
    const out = parseOpenAIError(500, 'boom')
    assert.equal(out, 'OpenAI API error (HTTP 500): boom')
  })
})

describe('classifier rules for onboarding misconfigurations', () => {
  it('404 is a non-retryable client error pointing at `rivet provider models`', () => {
    const c = classifyApiError(Object.assign(new Error('OpenAI API error (HTTP 404): x'), { status: 404 }))
    assert.equal(c.retryable, false)
    assert.equal(c.category, 'client_error')
    assert.equal(c.userMessage, 'Not found (404) — verify the model id with `rivet provider models <provider>`.')
  })

  it('a non-SSE 200 error passes its actionable message through, non-retryable', () => {
    const msg = '端点返回 200 但 content-type 是 application/json（不是 SSE 流）——端点可能不支持流式，或路径错误（baseUrl 是否缺 /v1？）。baseUrl=http://x/v1。响应片段：{}'
    const c = classifyApiError(Object.assign(new Error(msg), { status: 200, nonSse: true }))
    assert.equal(c.retryable, false)
    assert.equal(c.category, 'client_error')
    assert.equal(c.userMessage, msg)
  })
})

describe('OpenAIClient content-type gate', () => {
  const servers: Array<{ close: () => Promise<void> }> = []
  after(async () => {
    for (const s of servers) await s.close()
  })

  it('a 200 application/json response throws a non-SSE error instead of feeding JSON to the SSE parser', async () => {
    const server = http.createServer((_req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ error: 'wrong path — did you mean /v1/chat/completions?' }))
    })
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', () => resolve()))
    const address = server.address()
    const port = typeof address === 'object' && address ? address.port : 0
    servers.push({ close: () => new Promise(done => server.close(() => done())) })

    const client = new OpenAIClient({
      baseUrl: `http://127.0.0.1:${port}/v1`,
      apiKey: 'sk-x',
      model: 'some-model',
      maxTokens: 8,
    })
    await assert.rejects(
      client.stream(
        { model: 'some-model', messages: [{ role: 'user', content: 'hi' }] },
        {
          onTextDelta: () => {},
          onThinkingDelta: () => {},
          onContentBlock: () => {},
          onStopReason: () => {},
          onError: e => { throw e },
        },
      ),
      (e: unknown) => {
        const err = e as Error & { nonSse?: boolean; status?: number }
        assert.equal(err.nonSse, true, 'error carries the nonSse marker for the classifier')
        assert.equal(err.status, 200)
        assert.ok(err.message.includes('不是 SSE 流'), err.message)
        assert.ok(err.message.includes('baseUrl 是否缺 /v1'), err.message)
        return true
      },
    )
  })
})
