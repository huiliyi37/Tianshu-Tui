import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { htmlToMarkdown, decodeBody, extractMainContent } from '../extract.js'

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

describe('decodeBody', () => {
  it('decodes UTF-8 by default', () => {
    const bytes = new TextEncoder().encode('hello 世界')
    assert.equal(decodeBody(bytes, 'text/plain'), 'hello 世界')
  })

  it('uses charset from content-type header', () => {
    // shift_jis encoded hiragana 'あ' (0x82 0xA0)
    const bytes = new Uint8Array([0x82, 0xa0])
    assert.equal(decodeBody(bytes, 'text/html; charset=shift_jis'), 'あ')
  })

  it('sniffs meta charset for HTML without header', () => {
    const enc = new TextEncoder()
    const prefix = enc.encode('<html><head><meta charset="shift_jis"></head><body>')
    const suffix = enc.encode('</body></html>')
    const bodyChar = new Uint8Array([0x82, 0xa0])
    const bytes = new Uint8Array(prefix.length + bodyChar.length + suffix.length)
    bytes.set(prefix, 0)
    bytes.set(bodyChar, prefix.length)
    bytes.set(suffix, prefix.length + bodyChar.length)
    assert.equal(decodeBody(bytes, 'text/html').includes('あ'), true)
  })
})

describe('extractMainContent', () => {
  it('prefers <main> region', () => {
    const html = '<nav>noise</nav><main><p>important</p></main><footer>more noise</footer>'
    const result = extractMainContent(html)
    assert.ok(result.includes('important'))
    assert.ok(!result.includes('noise'))
  })

  it('falls back to <article>', () => {
    const html = '<article><p>article body</p></article><aside>ignored</aside>'
    const result = extractMainContent(html)
    assert.ok(result.includes('article body'))
    assert.ok(!result.includes('ignored'))
  })

  it('strips chrome elements from full page', () => {
    const html = '<header>logo</header><p>body</p><footer>copyright</footer>'
    const result = extractMainContent(html)
    assert.ok(result.includes('body'))
    assert.ok(!result.includes('logo'))
    assert.ok(!result.includes('copyright'))
  })
})
