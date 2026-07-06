import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  editFileArgProcessor,
  EDIT_FILE_POINTER_PREFIX,
  EDIT_FILE_THRESHOLD,
} from '../edit-file-arg-processor.js'

const bigOld = 'OLD'.repeat(EDIT_FILE_THRESHOLD) // well over threshold on its own
const bigNew = 'NEW'.repeat(EDIT_FILE_THRESHOLD)

describe('editFileArgProcessor', () => {
  it('collapses very large old/new strings into pointers, keeping file_path', () => {
    const args = JSON.stringify({ file_path: '/abs/foo.ts', old_string: bigOld, new_string: bigNew })
    const result = editFileArgProcessor.process(args)
    assert.ok(result)
    const parsed = JSON.parse(result!)
    assert.equal(parsed.file_path, '/abs/foo.ts')
    assert.ok((parsed.old_string as string).startsWith(EDIT_FILE_POINTER_PREFIX))
    assert.ok((parsed.old_string as string).includes('/abs/foo.ts'))
    assert.ok((parsed.new_string as string).includes('chars'))
    // bulk text must be collapsed — pointer is tiny vs the original payload
    // (260 = prefix + path + 80-char preview + anti-imitation suffix, see pointer-guard.ts)
    assert.ok((parsed.old_string as string).length < 260, 'old_string collapsed to a short pointer')
    assert.ok((parsed.new_string as string).length < 100, 'new_string collapsed to a short marker')
    assert.ok((parsed.old_string as string).length < bigOld.length)
  })

  it('keeps a short preview of the old block', () => {
    const old = 'function veryLongRewrite() {' + ' '.repeat(EDIT_FILE_THRESHOLD)
    const args = JSON.stringify({ file_path: '/a.ts', old_string: old, new_string: 'x'.repeat(EDIT_FILE_THRESHOLD) })
    const parsed = JSON.parse(editFileArgProcessor.process(args)!)
    assert.ok((parsed.old_string as string).includes('function veryLongRewrite'))
  })

  it('leaves ordinary edits inline (combined below threshold)', () => {
    const args = JSON.stringify({ file_path: '/a.ts', old_string: 'foo', new_string: 'bar' })
    assert.equal(editFileArgProcessor.process(args), null)
  })

  it('combined length exactly threshold-1 stays inline', () => {
    const old = 'a'.repeat(EDIT_FILE_THRESHOLD - 2)
    const args = JSON.stringify({ file_path: '/a.ts', old_string: old, new_string: 'b' })
    assert.equal(editFileArgProcessor.process(args), null)
  })

  it('is idempotent — re-processing returns null', () => {
    const args = JSON.stringify({ file_path: '/a.ts', old_string: bigOld, new_string: bigNew })
    const once = editFileArgProcessor.process(args)
    assert.ok(once)
    assert.equal(editFileArgProcessor.process(once!), null)
  })

  it('preserves replace_all and expected_count fields', () => {
    const args = JSON.stringify({
      file_path: '/a.ts', old_string: bigOld, new_string: bigNew, replace_all: true, expected_count: 3,
    })
    const parsed = JSON.parse(editFileArgProcessor.process(args)!)
    assert.equal(parsed.replace_all, true)
    assert.equal(parsed.expected_count, 3)
  })

  it('returns null when old_string or new_string missing', () => {
    assert.equal(editFileArgProcessor.process(JSON.stringify({ file_path: '/a.ts', old_string: bigOld })), null)
    assert.equal(editFileArgProcessor.process(JSON.stringify({ file_path: '/a.ts', new_string: bigNew })), null)
  })

  it('returns null when file_path missing', () => {
    assert.equal(editFileArgProcessor.process(JSON.stringify({ old_string: bigOld, new_string: bigNew })), null)
  })

  it('returns null on invalid JSON (fail-open)', () => {
    assert.equal(editFileArgProcessor.process('}{'), null)
  })

  it('result is valid JSON', () => {
    const args = JSON.stringify({ file_path: '/a.ts', old_string: bigOld, new_string: bigNew })
    JSON.parse(editFileArgProcessor.process(args)!)
  })
})
