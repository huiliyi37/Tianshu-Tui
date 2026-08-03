import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { BochaBackend } from '../bocha.js'

// Fixture: 博查 web-search 响应结构（InternLM/lagent BochaBrowser 实测字段 + 官方 siteName/datePublished）。
// data.webPages.value[] 每项含 name/url/snippet/summary/siteName/datePublished；
// summary 为 AI 摘要优先取用，siteName/datePublished 进 SearchResult 供来源判断。
const BOCHA_BODY = {
  code: 200,
  msg: 'success',
  data: {
    webPages: {
      value: [
        { name: '结果一', url: 'https://one.example', snippet: 'raw snippet one', summary: 'AI 摘要 one', siteName: '知乎', datePublished: '2026-07-15' },
        { name: '结果二', url: 'https://two.example', snippet: 'raw snippet two' },
      ],
    },
  },
}

describe('BochaBackend', () => {
  it('is unavailable without an API key', () => {
    assert.equal(new BochaBackend(async () => new Response(''), undefined).isAvailable(), false)
    assert.equal(new BochaBackend(async () => new Response(''), '').isAvailable(), false)
  })

  it('is available with a key', () => {
    assert.equal(new BochaBackend(async () => new Response(''), 'key').isAvailable(), true)
  })

  it('POSTs to the bocha endpoint with Bearer key, summary flag, and parses results', async () => {
    let calledUrl = ''
    let method = ''
    let headers: Record<string, string> = {}
    let body = ''
    const backend = new BochaBackend(async (url, init) => {
      calledUrl = url
      method = init?.method ?? ''
      headers = (init?.headers ?? {}) as Record<string, string>
      body = String(init?.body ?? '')
      return new Response(JSON.stringify(BOCHA_BODY), { status: 200 })
    }, 'sk-bocha-xxx')

    const results = await backend.search('蚂蚁集团', 5, new AbortController().signal)

    assert.equal(calledUrl, 'https://api.bochaai.com/v1/web-search')
    assert.equal(method, 'POST')
    assert.equal(headers['Authorization'], 'Bearer sk-bocha-xxx')
    assert.equal(headers['Content-Type'], 'application/json')
    assert.match(body, /"query":"蚂蚁集团"/)
    assert.match(body, /"summary":true/)
    assert.equal(results.length, 2)
    // summary 优先于 snippet；siteName/datePublished 进结果（博查独有，来源判断用）
    assert.deepEqual(results[0], {
      title: '结果一', url: 'https://one.example', snippet: 'AI 摘要 one',
      siteName: '知乎', publishedAt: '2026-07-15',
    })
    // 无 summary 时回退 snippet；无 siteName/datePublished 则不附（undefined 不序列化）
    assert.deepEqual(results[1], { title: '结果二', url: 'https://two.example', snippet: 'raw snippet two' })
  })

  it('throws on non-ok HTTP', async () => {
    const backend = new BochaBackend(async () => new Response('', { status: 401 }), 'k')
    await assert.rejects(() => backend.search('x', 5, new AbortController().signal), /HTTP 401/)
  })

  it('throws on bocha business error (code != 200 even with HTTP 200)', async () => {
    // key 无效时博查可能 HTTP 200 但 code 非 200 —— 必须当失败，让 chain 降级
    const body = { code: 401, msg: 'invalid api key' }
    const backend = new BochaBackend(async () => new Response(JSON.stringify(body), { status: 200 }), 'bad-key')
    await assert.rejects(
      () => backend.search('x', 5, new AbortController().signal),
      /bocha 401: invalid api key/,
    )
  })

  it('caps results at count and skips entries missing url/name', async () => {
    const body = {
      code: 200,
      data: {
        webPages: {
          value: [
            { name: 'ok', url: 'https://ok.example', summary: 's' },
            { name: 'no-url' },
            { url: 'https://no-name.example' },
          ],
        },
      },
    }
    const backend = new BochaBackend(async () => new Response(JSON.stringify(body), { status: 200 }), 'k')
    const results = await backend.search('x', 10, new AbortController().signal)
    assert.equal(results.length, 1)
    assert.equal(results[0]!.url, 'https://ok.example')
  })

  it('returns empty when webPages.value is missing (API shape change) — chain falls through', async () => {
    const body = { code: 200, data: {} }
    const backend = new BochaBackend(async () => new Response(JSON.stringify(body), { status: 200 }), 'k')
    const results = await backend.search('x', 5, new AbortController().signal)
    assert.equal(results.length, 0)
  })
})
