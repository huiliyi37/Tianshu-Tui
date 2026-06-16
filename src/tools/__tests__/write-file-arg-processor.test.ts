import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  writeFileArgProcessor,
  WRITE_FILE_POINTER_PREFIX,
  WRITE_FILE_CONTENT_THRESHOLD,
} from '../write-file-arg-processor.js'

const bigContent = 'x'.repeat(WRITE_FILE_CONTENT_THRESHOLD + 100)

describe('writeFileArgProcessor', () => {
  it('replaces large content with a file pointer referencing file_path', () => {
    const args = JSON.stringify({ file_path: '/abs/src/foo.ts', content: bigContent })
    const result = writeFileArgProcessor.process(args)
    assert.ok(result)
    const parsed = JSON.parse(result!)
    assert.ok((parsed.content as string).startsWith(WRITE_FILE_POINTER_PREFIX))
    assert.ok((parsed.content as string).includes('/abs/src/foo.ts'))
    assert.ok((parsed.content as string).includes('chars'))
    // file_path itself must be preserved verbatim
    assert.equal(parsed.file_path, '/abs/src/foo.ts')
    // full content must be gone
    assert.ok(!(parsed.content as string).includes(bigContent.slice(0, 50)))
  })

  it('reports correct line and char counts', () => {
    const content = ['line1', 'line2', 'line3'].join('\n') + '\n' + 'y'.repeat(WRITE_FILE_CONTENT_THRESHOLD)
    const args = JSON.stringify({ file_path: '/a.txt', content })
    const result = writeFileArgProcessor.process(args)
    assert.ok(result)
    const parsed = JSON.parse(result!)
    assert.ok((parsed.content as string).includes(`${content.length} chars`))
    assert.ok((parsed.content as string).includes(`${content.split('\n').length} lines`))
  })

  it('leaves small content inline (below threshold)', () => {
    const args = JSON.stringify({ file_path: '/a.txt', content: 'short config' })
    assert.equal(writeFileArgProcessor.process(args), null)
  })

  it('content exactly at threshold-1 stays inline', () => {
    const args = JSON.stringify({ file_path: '/a.txt', content: 'z'.repeat(WRITE_FILE_CONTENT_THRESHOLD - 1) })
    assert.equal(writeFileArgProcessor.process(args), null)
  })

  it('is idempotent — re-processing returns null', () => {
    const args = JSON.stringify({ file_path: '/abs/foo.ts', content: bigContent })
    const once = writeFileArgProcessor.process(args)
    assert.ok(once)
    assert.equal(writeFileArgProcessor.process(once!), null)
  })

  it('returns null when content is missing', () => {
    assert.equal(writeFileArgProcessor.process(JSON.stringify({ file_path: '/a.txt' })), null)
  })

  it('returns null when file_path is missing (no dangling pointer)', () => {
    assert.equal(writeFileArgProcessor.process(JSON.stringify({ content: bigContent })), null)
  })

  it('returns null on invalid JSON (fail-open)', () => {
    assert.equal(writeFileArgProcessor.process('{ not json'), null)
  })

  it('result is valid JSON', () => {
    const args = JSON.stringify({ file_path: '/a.txt', content: bigContent })
    const result = writeFileArgProcessor.process(args)
    assert.ok(result)
    JSON.parse(result!)
  })

  it('preserves other unrelated fields', () => {
    const args = JSON.stringify({ file_path: '/a.txt', content: bigContent, extra: 'keep' })
    const parsed = JSON.parse(writeFileArgProcessor.process(args)!)
    assert.equal(parsed.extra, 'keep')
  })
})
