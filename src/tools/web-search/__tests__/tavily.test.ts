import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { TavilyBackend } from '../tavily.js'

const TAVILY_BODY = {
  results: [
    { title: 'Alpha', url: 'https://alpha.example', content: 'a-content' },
    { title: 'Beta', url: 'https://beta.example', content: 'b-content' },
  ],
}

describe('TavilyBackend', () => {
  it('is unavailable without an API key', () => {
    assert.equal(new TavilyBackend(async () => new Response(''), undefined).isAvailable(), false)
    assert.equal(new TavilyBackend(async () => new Response(''), '').isAvailable(), false)
  })

  it('is available with a key', () => {
    assert.equal(new TavilyBackend(async () => new Response(''), 'key').isAvailable(), true)
  })

  it('POSTs query + max_results with auth header and parses results', async () => {
    let calledUrl = ''
    let method = ''
    let headers: Record<string, string> = {}
    let body: unknown
    const backend = new TavilyBackend(async (url, init) => {
      calledUrl = url
      method = init?.method ?? 'GET'
      headers = (init?.headers ?? {}) as Record<string, string>
      body = JSON.parse(String(init?.body ?? '{}'))
      return new Response(JSON.stringify(TAVILY_BODY), { status: 200 })
    }, 'tvly-key')

    const results = await backend.search('rust async', 3, new AbortController().signal)

    assert.equal(calledUrl, 'https://api.tavily.com/search')
    assert.equal(method, 'POST')
    assert.equal(headers['Authorization'], 'Bearer tvly-key')
    assert.deepEqual(body, { query: 'rust async', max_results: 3 })
    assert.equal(results.length, 2)
    assert.deepEqual(results[0], { title: 'Alpha', url: 'https://alpha.example', snippet: 'a-content' })
  })

  it('throws on non-ok HTTP', async () => {
    const backend = new TavilyBackend(async () => new Response('', { status: 500 }), 'k')
    await assert.rejects(() => backend.search('x', 3, new AbortController().signal), /HTTP 500/)
  })
})
