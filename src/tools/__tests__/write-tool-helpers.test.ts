import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { WRITE_TOOL_NAMES, extractWriteContents, extractWriteFilePaths } from '../write-tool-helpers.js'

describe('write-tool-helpers', () => {
  describe('WRITE_TOOL_NAMES', () => {
    it('covers all four edit tools + apply_patch', () => {
      assert.ok(WRITE_TOOL_NAMES.has('edit_file'))
      assert.ok(WRITE_TOOL_NAMES.has('write_file'))
      assert.ok(WRITE_TOOL_NAMES.has('hash_edit'))
      assert.ok(WRITE_TOOL_NAMES.has('ast_edit'))
      assert.ok(WRITE_TOOL_NAMES.has('apply_patch'))
    })
  })

  describe('extractWriteContents', () => {
    it('extracts from edit_file', () => {
      const r = extractWriteContents('edit_file', { file_path: 'src/a.ts', old_string: 'x', new_string: 'console.log("dbg")' })
      assert.equal(r.length, 1)
      assert.equal(r[0]!.filePath, 'src/a.ts')
      assert.equal(r[0]!.content, 'console.log("dbg")')
    })
    it('extracts from write_file', () => {
      const r = extractWriteContents('write_file', { file_path: 'src/a.ts', content: 'hello' })
      assert.equal(r[0]!.content, 'hello')
    })
    it('extracts from hash_edit', () => {
      const r = extractWriteContents('hash_edit', { file_path: 'src/a.ts', new_string: 'x' })
      assert.equal(r[0]!.content, 'x')
    })
    it('extracts from ast_edit with paths and ops', () => {
      const r = extractWriteContents('ast_edit', {
        paths: ['src/a.ts', 'src/b.ts'],
        ops: [{ find: 'var $X', replace: 'console.log("p1")' }, { find: 'var $Y', replace: 'debugger' }],
      })
      assert.equal(r.length, 4)
      assert.equal(r[0]!.filePath, 'src/a.ts')
      assert.equal(r[0]!.content, 'console.log("p1")')
      assert.equal(r[3]!.filePath, 'src/b.ts')
      assert.equal(r[3]!.content, 'debugger')
    })
    it('returns empty for ast_edit dryRun', () => {
      const r = extractWriteContents('ast_edit', { paths: ['src/a.ts'], ops: [{ find: 'x', replace: 'y' }], dryRun: true })
      assert.equal(r.length, 0)
    })
    it('returns empty for non-write tools', () => {
      assert.equal(extractWriteContents('read_file', { file_path: 'x' }).length, 0)
    })
  })

  describe('extractWriteFilePaths', () => {
    it('extracts from single-file tools', () => {
      assert.deepEqual(extractWriteFilePaths('edit_file', { file_path: 'src/a.ts' }), ['src/a.ts'])
      assert.deepEqual(extractWriteFilePaths('write_file', { file_path: 'src/b.ts' }), ['src/b.ts'])
      assert.deepEqual(extractWriteFilePaths('hash_edit', { file_path: 'src/c.ts' }), ['src/c.ts'])
    })
    it('extracts from ast_edit paths', () => {
      const r = extractWriteFilePaths('ast_edit', { paths: ['src/a.ts', 'src/b.ts'] })
      assert.deepEqual(r, ['src/a.ts', 'src/b.ts'])
    })
    it('returns empty for ast_edit dryRun', () => {
      const r = extractWriteFilePaths('ast_edit', { paths: ['src/a.ts'], dryRun: true })
      assert.equal(r.length, 0)
    })
    it('handles apply_patch path', () => {
      const r = extractWriteFilePaths('apply_patch', { path: 'src/foo.ts' })
      assert.deepEqual(r, ['src/foo.ts'])
    })
  })
})
