import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { BraveBackend } from '../brave.js'

const BRAVE_BODY = {
  web: {
    results: [
      { title: 'Result One', url: 'https://one.example', description: 'first' },
      { title: 'Result Two', url: 'https://two.example', description: 'second' },
    ],
  },
}

describe('BraveBackend', () => {
  it('is unavailable without an API key', () => {
    assert.equal(new BraveBackend(async () => new Response(''), undefined).isAvailable(), false)
    assert.equal(new BraveBackend(async () => new Response(''), '').isAvailable(), false)
  })

  it('is available with a key', () => {
    assert.equal(new BraveBackend(async () => new Response(''), 'key').isAvailable(), true)
  })

  it('sends the key header, query params, and parses results', async () => {
    let calledUrl = ''
    let headers: Record<string, string> = {}
    const backend = new BraveBackend(async (url, init) => {
      calledUrl = url
      headers = (init?.headers ?? {}) as Record<string, string>
      return new Response(JSON.stringify(BRAVE_BODY), { status: 200 })
    }, 'secret-token', 'us')

    const results = await backend.search('node streams', 5, new AbortController().signal)

    assert.ok(calledUrl.startsWith('https://api.search.brave.com/res/v1/web/search?'))
    assert.match(calledUrl, /q=node\+streams/)
    assert.match(calledUrl, /count=5/)
    assert.match(calledUrl, /country=us/)
    assert.equal(headers['X-Subscription-Token'], 'secret-token')
    assert.equal(results.length, 2)
    assert.deepEqual(results[0], { title: 'Result One', url: 'https://one.example', snippet: 'first' })
  })

  it('throws on non-ok HTTP', async () => {
    const backend = new BraveBackend(async () => new Response('', { status: 401 }), 'k')
    await assert.rejects(() => backend.search('x', 5, new AbortController().signal), /HTTP 401/)
  })

  it('caps results at count and skips entries missing url/title', async () => {
    const body = { web: { results: [
      { title: 'ok', url: 'https://ok.example', description: 'd' },
      { title: 'no-url' },
      { url: 'https://no-title.example' },
    ] } }
    const backend = new BraveBackend(async () => new Response(JSON.stringify(body), { status: 200 }), 'k')
    const results = await backend.search('x', 10, new AbortController().signal)
    assert.equal(results.length, 1)
    assert.equal(results[0]!.url, 'https://ok.example')
  })
})
