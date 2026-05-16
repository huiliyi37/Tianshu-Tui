import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { getEditorCommand, createTempFile, readAndCleanup } from '../tui/external-editor.js'

describe('getEditorCommand', () => {
  it('returns vi as fallback', () => {
    assert.ok(getEditorCommand().length > 0)
  })
})

describe('createTempFile + readAndCleanup', () => {
  it('writes content and reads it back', () => {
    const path = createTempFile('hello editor')
    assert.ok(path.includes('RIVET_INPUT.md'))
    const content = readAndCleanup(path)
    assert.equal(content, 'hello editor')
  })

  it('creates unique temp dirs', () => {
    const a = createTempFile('a')
    const b = createTempFile('b')
    assert.notEqual(a, b)
    readAndCleanup(a)
    readAndCleanup(b)
  })
})
