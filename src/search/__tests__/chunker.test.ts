import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { chunkByDefinitions, familyForExt, windowChunks } from '../chunker-treesitter.js'

describe('chunker: familyForExt', () => {
  it('maps polyglot extensions to families', () => {
    assert.equal(familyForExt('.py'), 'py')
    assert.equal(familyForExt('.go'), 'go')
    assert.equal(familyForExt('.rs'), 'rs')
    assert.equal(familyForExt('.java'), 'java')
    assert.equal(familyForExt('.unknown'), null)
  })
})

describe('chunker: chunkByDefinitions', () => {
  it('splits Python on def/class boundaries', () => {
    const py = [
      'import os',
      '',
      'def alpha():',
      '    return 1',
      '',
      'def beta():',
      '    return 2',
      '',
      'class Gamma:',
      '    def method(self):',
      '        return 3',
    ].join('\n')
    const chunks = chunkByDefinitions(py, '.py')
    assert.ok(chunks.length >= 2, 'should produce multiple definition chunks')
    // The chunk containing alpha must include its body.
    const alphaChunk = chunks.find(c => c.text.includes('def alpha'))
    assert.ok(alphaChunk)
    assert.ok(alphaChunk!.text.includes('return 1'))
    // Line ranges are 1-based and sane.
    for (const c of chunks) {
      assert.ok(c.startLine >= 1)
      assert.ok(c.endLine >= c.startLine)
    }
  })

  it('splits Go on func boundaries', () => {
    const go = [
      'package main',
      '',
      'func Foo() int {',
      '\treturn 1',
      '}',
      '',
      'func Bar() int {',
      '\treturn 2',
      '}',
    ].join('\n')
    const chunks = chunkByDefinitions(go, '.go')
    assert.ok(chunks.some(c => c.text.includes('func Foo')))
    assert.ok(chunks.some(c => c.text.includes('func Bar')))
  })

  it('falls back to window chunks for non-code (markdown)', () => {
    const md = Array.from({ length: 100 }, (_, i) => `line ${i}`).join('\n')
    const chunks = chunkByDefinitions(md, '.md')
    assert.ok(chunks.length >= 2)
    assert.equal(chunks[0]!.startLine, 1)
  })

  it('windowChunks produces 1-based contiguous ranges', () => {
    const content = Array.from({ length: 50 }, (_, i) => `x${i}`).join('\n')
    const chunks = windowChunks(content, 20, 5)
    assert.equal(chunks[0]!.startLine, 1)
    assert.ok(chunks.every(c => c.endLine >= c.startLine))
  })
})
