import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { createWebFetchTool } from '../tool.js'

function publicLookup() {
  return async (_hostname: string) => ({ address: '93.184.216.34' })
}

function textResponse(text: string, contentType = 'text/html', status = 200): Response {
  return new Response(text, {
    status,
    headers: { 'content-type': contentType },
  })
}

describe('createWebFetchTool', () => {
  it('has correct definition name', () => {
    const tool = createWebFetchTool()
    assert.equal(tool.definition.name, 'web_fetch')
  })

  it('rejects invalid URLs', async () => {
    const tool = createWebFetchTool()
    const result = await tool.execute({ input: { url: 'not-a-url' }, toolUseId: 'tu_1', cwd: '/' } as any)
    assert.equal(result.isError, true)
    assert.ok(result.content.includes('Invalid URL'))
  })

  it('rejects non-http protocols', async () => {
    const tool = createWebFetchTool()
    const result = await tool.execute({ input: { url: 'file:///etc/passwd' }, toolUseId: 'tu_2', cwd: '/' } as any)
    assert.equal(result.isError, true)
    assert.ok(result.content.includes('Unsupported protocol'))
  })

  it('requires approval', () => {
    const tool = createWebFetchTool()
    assert.equal(tool.requiresApproval({ input: { url: 'https://example.com' }, toolUseId: 't', cwd: '/' } as any), true)
  })

  it('rejects binary content types', async () => {
    const tool = createWebFetchTool({
      lookup: publicLookup(),
      fetch: async () => textResponse('binary', 'application/pdf'),
    })
    const result = await tool.execute({ input: { url: 'https://example.com/file.pdf' }, toolUseId: 'tu_bin', cwd: '/' } as any)
    assert.equal(result.isError, true)
    assert.ok(result.content.includes('Binary content'))
    assert.ok(result.content.includes('import_resource'))
  })

  it('returns full content without 50K truncation', async () => {
    const longText = 'x'.repeat(60_000)
    const tool = createWebFetchTool({
      lookup: publicLookup(),
      fetch: async () => textResponse(`<p>${longText}</p>`, 'text/html'),
    })
    const result = await tool.execute({ input: { url: 'https://example.com/long' }, toolUseId: 'tu_long', cwd: '/' } as any)
    assert.equal(result.isError, undefined)
    assert.ok(result.content.includes(longText))
    assert.ok(!result.content.includes('truncated'))
  })

  it('returns HTTP error for non-2xx', async () => {
    const tool = createWebFetchTool({
      lookup: publicLookup(),
      fetch: async () => textResponse('not found', 'text/plain', 404),
    })
    const result = await tool.execute({ input: { url: 'https://example.com/missing' }, toolUseId: 'tu_404', cwd: '/' } as any)
    assert.equal(result.isError, true)
    assert.ok(result.content.includes('HTTP 404'))
  })
})
