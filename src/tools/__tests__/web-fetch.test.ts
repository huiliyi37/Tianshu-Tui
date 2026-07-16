import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { createWebFetchTool, htmlToMarkdown } from '../web-fetch.js'
import { isPrivateIP } from '../web-fetch.js'
import type { FetchLike } from '../net/http-fetch.js'

/** DOM Response ≡ undici Response at runtime; bridge the nominal type gap. */
const mockFetch = (fn: (url: string, init?: RequestInit) => Promise<Response>): FetchLike =>
  fn as unknown as FetchLike

describe('htmlToMarkdown (turndown)', () => {
  it('strips HTML tags and preserves text', async () => {
    const result = await htmlToMarkdown('<p>Hello <strong>world</strong></p>')
    assert.ok(result.includes('Hello'))
    assert.ok(!result.includes('<p>'))
    assert.ok(result.includes('**world**'))
  })

  it('converts links to markdown format', async () => {
    const result = await htmlToMarkdown('<a href="https://example.com">link</a>')
    assert.ok(result.includes('[link](https://example.com)'))
  })

  it('handles empty input', async () => {
    assert.equal(await htmlToMarkdown(''), '')
  })

  it('converts headings', async () => {
    const result = await htmlToMarkdown('<h1>Title</h1>')
    assert.ok(result.includes('# Title'))
  })

  it('converts unordered lists', async () => {
    const result = await htmlToMarkdown('<ul><li>one</li><li>two</li></ul>')
    assert.ok(result.includes('one'))
    assert.ok(result.includes('two'))
  })

  it('converts code blocks', async () => {
    const result = await htmlToMarkdown('<pre><code>const x = 1</code></pre>')
    assert.ok(result.includes('const x = 1'))
  })

  it('strips script and style tags', async () => {
    const result = await htmlToMarkdown('<script>alert("xss")</script><p>visible</p><style>.x{color:red}</style>')
    assert.ok(!result.includes('alert'))
    assert.ok(!result.includes('color'))
    assert.ok(result.includes('visible'))
  })

  it('converts tables to readable text', async () => {
    const html = '<table><tr><th>Name</th><th>Value</th></tr><tr><td>foo</td><td>bar</td></tr></table>'
    const result = await htmlToMarkdown(html)
    assert.ok(result.includes('Name'))
    assert.ok(result.includes('foo'))
  })

  it('decodes HTML entities', async () => {
    const result = await htmlToMarkdown('<p>a &amp; b</p>')
    assert.ok(result.includes('a & b'))
  })
})

describe('WEB_FETCH_TOOL', () => {
  const tool = createWebFetchTool()

  it('has correct definition name', () => {
    assert.equal(tool.definition.name, 'web_fetch')
  })

  it('rejects invalid URLs', async () => {
    const result = await tool.execute({
      input: { url: 'not-a-url' },
      toolUseId: 'tu_1',
      cwd: '/',
    })
    assert.equal(result.isError, true)
    assert.ok(result.content.includes('Invalid URL'))
  })

  it('rejects non-http protocols', async () => {
    const result = await tool.execute({
      input: { url: 'file:///etc/passwd' },
      toolUseId: 'tu_2',
      cwd: '/',
    })
    assert.equal(result.isError, true)
    assert.ok(result.content.includes('Unsupported protocol'))
  })

  it('requires approval', () => {
    assert.equal(
      tool.requiresApproval({ input: { url: 'https://example.com' }, toolUseId: 't', cwd: '/' }),
      true,
    )
  })
})

describe('web_fetch redirect SSRF', () => {
  it('rejects redirect to private IP', async () => {
    const tool = createWebFetchTool({
      lookup: async (hostname: string) => {
        if (hostname === 'evil.com') return { address: '10.0.0.1' }
        return { address: '93.184.216.34' }
      },
      fetch: mockFetch(async (_url: string, init?: RequestInit) => {
        return new Response(null, {
          status: 302,
          headers: { Location: 'http://evil.com/private' },
        })
      }),
    })

    const result = await tool.execute({
      input: { url: 'https://public.example.com/page' },
      toolUseId: 'tu_ssrf',
      cwd: '/',
    })
    assert.equal(result.isError, true)
    assert.ok(result.content.includes('Access denied'))
    assert.ok(result.content.includes('10.0.0.1'))
  })

  it('allows redirect to public URL', async () => {
    let fetchCalled = 0
    const tool = createWebFetchTool({
      lookup: async () => ({ address: '93.184.216.34' }),
      fetch: mockFetch(async (url: string, init?: RequestInit) => {
        fetchCalled++
        if (fetchCalled === 1) {
          return new Response(null, {
            status: 301,
            headers: { Location: 'https://public2.example.com/page' },
          })
        }
        return new Response('<p>OK</p>', {
          status: 200,
          headers: { 'content-type': 'text/html' },
        })
      }),
    })

    const result = await tool.execute({
      input: { url: 'https://public.example.com/page' },
      toolUseId: 'tu_redirect',
      cwd: '/',
    })
    assert.equal(result.isError, undefined)
    assert.ok(result.content.includes('OK'))
  })
})

describe('isPrivateIP', () => {
  it('detects loopback IPv4', () => {
    assert.equal(isPrivateIP('127.0.0.1'), true)
  })

  it('detects 10.x.x.x range', () => {
    assert.equal(isPrivateIP('10.0.0.1'), true)
  })

  it('detects 192.168.x.x range', () => {
    assert.equal(isPrivateIP('192.168.1.1'), true)
  })

  it('detects 172.16.x.x range', () => {
    assert.equal(isPrivateIP('172.16.0.1'), true)
  })

  it('detects link-local 169.254.x.x', () => {
    assert.equal(isPrivateIP('169.254.169.254'), true)
  })

  it('allows public IPs', () => {
    assert.equal(isPrivateIP('8.8.8.8'), false)
    assert.equal(isPrivateIP('1.1.1.1'), false)
  })

  it('detects IPv6 loopback', () => {
    assert.equal(isPrivateIP('::1'), true)
  })

  it('allows public IPv6', () => {
    assert.equal(isPrivateIP('2001:4860:4860::8888'), false)
  })
})
