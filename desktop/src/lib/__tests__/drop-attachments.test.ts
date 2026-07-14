import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { classifyAttachmentPath, makeFileMention } from '../drop-attachments'

describe('drop-attachments', () => {
  it('classifies image paths by extension', () => {
    assert.equal(classifyAttachmentPath('/tmp/cat.png'), 'image')
    assert.equal(classifyAttachmentPath('C:\\Users\\x\\pic.jpg'), 'image')
  })

  it('classifies text paths by extension', () => {
    assert.equal(classifyAttachmentPath('/project/src/a.ts'), 'text')
    assert.equal(classifyAttachmentPath('/project/README.md'), 'text')
  })

  it('classifies archives as unsupported', () => {
    assert.equal(classifyAttachmentPath('/tmp/x.zip'), 'archive')
  })

  it('classifies known binaries as unsupported', () => {
    assert.equal(classifyAttachmentPath('/tmp/x.pdf'), 'unsupported')
  })

  it('treats unknown extensions as text (agent can attempt to read)', () => {
    assert.equal(classifyAttachmentPath('/tmp/foo.unknown'), 'text')
  })

  it('converts in-project absolute paths to relative @file mentions', () => {
    const cwd = '/Users/me/project'
    assert.equal(makeFileMention('/Users/me/project/src/a.ts', cwd), '@file:src/a.ts')
  })

  it('keeps out-of-project paths absolute', () => {
    const cwd = '/Users/me/project'
    assert.equal(makeFileMention('/Users/me/Downloads/note.txt', cwd), '@file:/Users/me/Downloads/note.txt')
  })

  it('quotes paths containing spaces', () => {
    const cwd = '/Users/me/project'
    assert.equal(
      makeFileMention('/Users/me/project/my notes.txt', cwd),
      '@file:"my notes.txt"',
    )
  })

  it('normalizes Windows separators', () => {
    const cwd = 'C:\\project'
    assert.equal(makeFileMention('C:\\project\\src\\a.ts', cwd), '@file:src/a.ts')
  })
})
