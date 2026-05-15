import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { WEB_FETCH_TOOL, htmlToMarkdown } from '../web-fetch.js'

describe('htmlToMarkdown', () => {
  it('strips HTML tags and preserves text', () => {
    const result = htmlToMarkdown('<p>Hello <b>world</b></p>')
    assert.ok(result.includes('Hello'))
    assert.ok(!result.includes('<p>'))
  })

  it('converts links to markdown format', () => {
    const result = htmlToMarkdown('<a href="https://example.com">link</a>')
    assert.ok(result.includes('[link](https://example.com)'))
  })

  it('handles empty input', () => {
    assert.equal(htmlToMarkdown(''), '')
  })

  it('converts headings', () => {
    const result = htmlToMarkdown('<h2>Title</h2>')
    assert.ok(result.includes('## Title'))
  })

  it('decodes HTML entities', () => {
    const result = htmlToMarkdown('<p>a &amp; b</p>')
    assert.ok(result.includes('a & b'))
  })
})

describe('WEB_FETCH_TOOL', () => {
  it('has correct definition name', () => {
    assert.equal(WEB_FETCH_TOOL.definition.name, 'web_fetch')
  })

  it('rejects invalid URLs', async () => {
    const result = await WEB_FETCH_TOOL.execute({
      input: { url: 'not-a-url' },
      toolUseId: 'tu_1',
      cwd: '/',
    })
    assert.equal(result.isError, true)
    assert.ok(result.content.includes('Invalid URL'))
  })

  it('rejects non-http protocols', async () => {
    const result = await WEB_FETCH_TOOL.execute({
      input: { url: 'file:///etc/passwd' },
      toolUseId: 'tu_2',
      cwd: '/',
    })
    assert.equal(result.isError, true)
    assert.ok(result.content.includes('Unsupported protocol'))
  })

  it('requires approval', () => {
    assert.equal(
      WEB_FETCH_TOOL.requiresApproval({ input: { url: 'https://example.com' }, toolUseId: 't', cwd: '/' }),
      true,
    )
  })
})
