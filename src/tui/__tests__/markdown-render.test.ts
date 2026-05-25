import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { parseBlocks, parseInline, keywordsForLang } from '../markdown-render.js'

describe('parseInline', () => {
  it('parses bold text', () => {
    const segs = parseInline('hello **world** end')
    assert.equal(segs.length, 3)
    assert.deepEqual(segs[0], { text: 'hello ' })
    assert.deepEqual(segs[1], { text: 'world', bold: true })
    assert.deepEqual(segs[2], { text: ' end' })
  })

  it('parses italic text', () => {
    const segs = parseInline('hello *world* end')
    assert.equal(segs.length, 3)
    assert.deepEqual(segs[1], { text: 'world', italic: true })
  })

  it('parses inline code', () => {
    const segs = parseInline('use `npm install` to setup')
    assert.equal(segs.length, 3)
    assert.deepEqual(segs[1], { text: 'npm install', code: true })
  })

  it('parses links', () => {
    const segs = parseInline('see [docs](https://example.com) for info')
    assert.equal(segs.length, 3)
    assert.deepEqual(segs[1], { text: 'docs', underline: true })
  })

  it('returns plain text for no formatting', () => {
    assert.deepEqual(parseInline('plain text'), [{ text: 'plain text' }])
  })

  it('handles unclosed delimiters gracefully', () => {
    assert.deepEqual(parseInline('hello **world end'), [{ text: 'hello **world end' }])
  })

  it('parses mixed formatting', () => {
    const segs = parseInline('**bold** and `code` mixed')
    assert.equal(segs.length, 4)
    assert.deepEqual(segs[0], { text: 'bold', bold: true })
    assert.deepEqual(segs[2], { text: 'code', code: true })
  })
})

describe('parseBlocks', () => {
  it('parses paragraphs', () => {
    const blocks = parseBlocks('hello world\nthis is a paragraph')
    assert.equal(blocks.length, 1)
    assert.equal(blocks[0]!.type, 'paragraph')
  })

  it('parses headers', () => {
    const blocks = parseBlocks('# Title\n## Subtitle\n### H3')
    assert.equal(blocks.length, 3)
    assert.deepEqual(blocks[0], { type: 'header', level: 1, content: 'Title' })
    assert.deepEqual(blocks[1], { type: 'header', level: 2, content: 'Subtitle' })
    assert.deepEqual(blocks[2], { type: 'header', level: 3, content: 'H3' })
  })

  it('parses code blocks', () => {
    const blocks = parseBlocks('```ts\nconst x = 1\n```')
    assert.equal(blocks.length, 1)
    assert.equal(blocks[0]!.type, 'code')
    assert.equal(blocks[0]!.language, 'ts')
    assert.equal(blocks[0]!.content, 'const x = 1')
  })

  it('parses code blocks without language', () => {
    const blocks = parseBlocks('```\nsome code\n```')
    assert.equal(blocks.length, 1)
    assert.equal(blocks[0]!.language, undefined)
  })

  it('parses lists', () => {
    const blocks = parseBlocks('- item one\n- item two\n- item three')
    assert.equal(blocks.length, 1)
    assert.equal(blocks[0]!.type, 'list')
    assert.deepEqual(blocks[0]!.items, ['item one', 'item two', 'item three'])
  })

  it('parses blockquotes', () => {
    const blocks = parseBlocks('> quoted text\n> more quote')
    assert.equal(blocks.length, 1)
    assert.equal(blocks[0]!.type, 'blockquote')
    assert.equal(blocks[0]!.content, 'quoted text\nmore quote')
  })

  it('parses horizontal rules', () => {
    const blocks = parseBlocks('---')
    assert.equal(blocks.length, 1)
    assert.equal(blocks[0]!.type, 'hr')
  })

  it('skips blank lines', () => {
    const blocks = parseBlocks('para one\n\npara two')
    assert.equal(blocks.length, 2)
    assert.equal(blocks[0]!.content, 'para one')
    assert.equal(blocks[1]!.content, 'para two')
  })

  it('parses tables', () => {
    const blocks = parseBlocks('| a | b |\n|---|---|\n| 1 | 2 |')
    assert.equal(blocks.length, 1)
    assert.equal(blocks[0]!.type, 'table')
  })

  it('handles mixed content', () => {
    const text = '# Title\n\nParagraph with **bold**.\n\n```\ncode\n```\n\n- list item'
    const blocks = parseBlocks(text)
    assert.equal(blocks.length, 4)
    assert.deepEqual(blocks.map(b => b.type), ['header', 'paragraph', 'code', 'list'])
  })
})

describe('keywordsForLang', () => {
  it('returns keywords for C++', () => {
    const config = keywordsForLang('cpp')
    assert.ok(config)
    assert.ok(config.keywords.has('class'))
    assert.ok(config.keywords.has('template'))
  })

  it('returns keywords for Java', () => {
    const config = keywordsForLang('java')
    assert.ok(config)
    assert.ok(config.keywords.has('public'))
    assert.ok(config.keywords.has('synchronized'))
  })

  it('returns case-insensitive config for SQL', () => {
    const config = keywordsForLang('sql')
    assert.ok(config)
    assert.equal(config.caseInsensitive, true)
    assert.ok(config.keywords.has('select'))
  })

  it('returns case-insensitive config for Dockerfile', () => {
    const config = keywordsForLang('dockerfile')
    assert.ok(config)
    assert.equal(config.caseInsensitive, true)
    assert.ok(config.keywords.has('from'))
  })

  it('returns keywords for Ruby', () => {
    const config = keywordsForLang('ruby')
    assert.ok(config)
    assert.ok(config.keywords.has('def'))
  })

  it('returns keywords for PHP', () => {
    const config = keywordsForLang('php')
    assert.ok(config)
    assert.ok(config.keywords.has('foreach'))
  })

  it('returns keywords for Swift', () => {
    const config = keywordsForLang('swift')
    assert.ok(config)
    assert.ok(config.keywords.has('guard'))
  })

  it('returns keywords for Kotlin', () => {
    const config = keywordsForLang('kotlin')
    assert.ok(config)
    assert.ok(config.keywords.has('companion'))
  })

  it('returns null for unknown language', () => {
    const config = keywordsForLang('unknown')
    assert.equal(config, null)
  })
})
