import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  hashEditArgProcessor,
  HASH_EDIT_POINTER_PREFIX,
  HASH_EDIT_THRESHOLD,
} from '../hash-edit-arg-processor.js'

const bigNew = 'const x = 1\n'.repeat(HASH_EDIT_THRESHOLD) // well over threshold

describe('hashEditArgProcessor', () => {
  it('replaces large new_string with a file pointer, keeping anchors + file_path', () => {
    const args = JSON.stringify({ file_path: '/abs/src/foo.ts', anchors: ['L5:a1b2c3d4', 'L7:e5f6a7b8'], new_string: bigNew })
    const result = hashEditArgProcessor.process(args)
    assert.ok(result)
    const parsed = JSON.parse(result!)
    assert.ok((parsed.new_string as string).startsWith(HASH_EDIT_POINTER_PREFIX))
    assert.ok((parsed.new_string as string).includes('/abs/src/foo.ts'))
    assert.ok((parsed.new_string as string).includes('chars'))
    assert.equal(parsed.file_path, '/abs/src/foo.ts')
    assert.deepEqual(parsed.anchors, ['L5:a1b2c3d4', 'L7:e5f6a7b8'])
    assert.ok(!(parsed.new_string as string).includes(bigNew.slice(0, 50)))
  })

  it('reports correct line and char counts', () => {
    const content = ['a', 'b', 'c'].join('\n') + '\n' + 'z'.repeat(HASH_EDIT_THRESHOLD)
    const args = JSON.stringify({ file_path: '/a.ts', anchors: ['L1'], new_string: content })
    const parsed = JSON.parse(hashEditArgProcessor.process(args)!)
    assert.ok((parsed.new_string as string).includes(`${content.length} chars`))
    assert.ok((parsed.new_string as string).includes(`${content.split('\n').length} lines`))
  })

  it('leaves small new_string inline (below threshold)', () => {
    const args = JSON.stringify({ file_path: '/a.ts', anchors: ['L1'], new_string: 'small change' })
    assert.equal(hashEditArgProcessor.process(args), null)
  })

  it('leaves empty new_string (deletion) inline', () => {
    const args = JSON.stringify({ file_path: '/a.ts', anchors: ['L1', 'L3'], new_string: '' })
    assert.equal(hashEditArgProcessor.process(args), null)
  })

  it('is idempotent — re-processing returns null', () => {
    const args = JSON.stringify({ file_path: '/a.ts', anchors: ['L1'], new_string: bigNew })
    const once = hashEditArgProcessor.process(args)
    assert.ok(once)
    assert.equal(hashEditArgProcessor.process(once!), null)
  })

  it('returns null when file_path is missing (no dangling pointer)', () => {
    assert.equal(hashEditArgProcessor.process(JSON.stringify({ anchors: ['L1'], new_string: bigNew })), null)
  })

  it('returns null on invalid JSON (fail-open)', () => {
    assert.equal(hashEditArgProcessor.process('{not json'), null)
  })

  it('result is valid JSON', () => {
    const args = JSON.stringify({ file_path: '/a.ts', anchors: ['L1'], new_string: bigNew })
    JSON.parse(hashEditArgProcessor.process(args)!)
  })
})
