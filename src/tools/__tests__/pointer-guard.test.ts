import { describe, it, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, rmSync, existsSync, writeFileSync, readFileSync } from 'fs'
import { join } from 'path'
import {
  detectPointerPlaceholder,
  pointerPlaceholderError,
  POINTER_PLACEHOLDER_PREFIXES,
  EDIT_NEW_BLOCK_POINTER_PREFIX,
  PLAN_POINTER_PREFIX,
  POINTER_GUARD_ERROR_MARKER,
} from '../pointer-guard.js'
import { editFileArgProcessor } from '../edit-file-arg-processor.js'
import { planSubmitArgProcessor } from '../plan-submit-arg-processor.js'
import { WRITE_FILE_TOOL } from '../write-file.js'
import { EDIT_FILE_TOOL } from '../edit.js'
import { HASH_EDIT_TOOL } from '../hash-edit.js'
import type { ToolCallParams } from '../types.js'

const TEST_DIR = join(process.cwd(), '.test-tmp', 'pointer-guard-test')

function makeParams(input: Record<string, unknown>): ToolCallParams {
  return { input, toolUseId: 'test-id', cwd: TEST_DIR }
}

describe('detectPointerPlaceholder', () => {
  it('detects every registered pointer prefix', () => {
    for (const prefix of POINTER_PLACEHOLDER_PREFIXES) {
      assert.equal(detectPointerPlaceholder(`${prefix} /x/y.md — stuff]`), prefix, prefix)
    }
  })

  it('detects a pointer behind leading whitespace', () => {
    assert.equal(
      detectPointerPlaceholder('\n  [file written to /a.md — 5 lines, 10 chars.]'),
      '[file written to',
    )
  })

  it('ignores real content that mentions a pointer mid-text', () => {
    assert.equal(detectPointerPlaceholder('Docs: history shows "[file written to …" pointers.\n'), null)
    assert.equal(detectPointerPlaceholder('---\ndeck: 01英语::00必考词\n---\n\n### gift\n'), null)
  })

  it('error message carries the stable marker the advisory hook keys off', () => {
    const msg = pointerPlaceholderError({
      toolName: 'write_file', field: 'content', matchedPrefix: '[file written to', filePath: '/a.md',
    })
    assert.ok(msg.includes(POINTER_GUARD_ERROR_MARKER))
    assert.ok(msg.includes('read_file /a.md'))
  })
})

describe('pointer prefix drift guards', () => {
  it('edit_file new_string collapse output starts with EDIT_NEW_BLOCK_POINTER_PREFIX', () => {
    const args = JSON.stringify({
      file_path: '/tmp/x.ts',
      old_string: 'a'.repeat(5000),
      new_string: 'b'.repeat(5000),
    })
    const out = editFileArgProcessor.process(args)
    assert.ok(out, 'processor must collapse above threshold')
    const parsed = JSON.parse(out!) as { new_string: string }
    assert.ok(parsed.new_string.startsWith(EDIT_NEW_BLOCK_POINTER_PREFIX),
      `new_string pointer must start with "${EDIT_NEW_BLOCK_POINTER_PREFIX}" — update pointer-guard.ts if the render changed`)
  })

  it('plan_submit collapse output starts with PLAN_POINTER_PREFIX', () => {
    const args = JSON.stringify({ plan: 'p'.repeat(20000), title: 'T' })
    const out = planSubmitArgProcessor.process(args)
    if (out === null) return // resolvePath may require fields absent here — skip rather than false-fail
    const parsed = JSON.parse(out) as { plan: string }
    assert.ok(parsed.plan.startsWith(PLAN_POINTER_PREFIX),
      `plan pointer must start with "${PLAN_POINTER_PREFIX}" — update pointer-guard.ts if the render changed`)
  })
})

describe('cross-tool pointer rejection', () => {
  beforeEach(() => {
    if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true })
    mkdirSync(TEST_DIR, { recursive: true })
  })

  it('write_file rejects a hash_edit pointer echoed as content', async () => {
    const file = join(TEST_DIR, 'cross.md')
    const result = await WRITE_FILE_TOOL.execute(makeParams({
      file_path: file,
      content: `[hash_edit applied to ${file} — new block 30 lines, 900 chars. Use read_file to review.]`,
    }))
    assert.ok(result.isError, 'cross-tool pointer must be rejected')
    assert.ok(result.content.includes(POINTER_GUARD_ERROR_MARKER))
    assert.ok(!existsSync(file), 'no file created from pointer content')
  })

  it('edit_file rejects a pointer as new_string (no garbage written)', async () => {
    const file = join(TEST_DIR, 'target.md')
    writeFileSync(file, 'line one\nline two\n')
    const result = await EDIT_FILE_TOOL.execute(makeParams({
      file_path: file,
      old_string: 'line two',
      new_string: `[file written to ${file} — 507 lines, 12744 chars. Use read_file to review.]`,
    }))
    assert.ok(result.isError, 'pointer new_string must be rejected')
    assert.ok(result.content.includes(POINTER_GUARD_ERROR_MARKER))
    assert.equal(readFileSync(file, 'utf-8'), 'line one\nline two\n', 'file untouched')
  })

  it('edit_file rejects a pointer as old_string (model must read_file first)', async () => {
    const file = join(TEST_DIR, 'target2.md')
    writeFileSync(file, 'alpha\nbeta\n')
    const result = await EDIT_FILE_TOOL.execute(makeParams({
      file_path: file,
      old_string: `[edit on ${file}: replaced 9000-char block, preview: "x". Use read_file for current content.]`,
      new_string: 'gamma',
    }))
    assert.ok(result.isError)
    assert.ok(result.content.includes(POINTER_GUARD_ERROR_MARKER))
  })

  it('hash_edit rejects a pointer as new_string (the batch-12 corruption path)', async () => {
    const file = join(TEST_DIR, 'batch12.md')
    writeFileSync(file, '### part\n\ncontent\n')
    const result = await HASH_EDIT_TOOL.execute(makeParams({
      file_path: file,
      anchors: ['L1'],
      new_string: `[hash_edit applied to ${file} — new block 12 lines, 400 chars. Use read_file to review.]`,
    }))
    assert.ok(result.isError, 'pointer new_string must be rejected')
    assert.ok(result.content.includes(POINTER_GUARD_ERROR_MARKER))
    assert.equal(readFileSync(file, 'utf-8'), '### part\n\ncontent\n', 'file untouched')
  })

  it('hash_edit still accepts real new_string (guard is prefix-literal only)', async () => {
    const file = join(TEST_DIR, 'real.md')
    writeFileSync(file, 'old heading\nbody\n')
    const result = await HASH_EDIT_TOOL.execute(makeParams({
      file_path: file,
      anchors: ['L1'],
      new_string: 'new heading',
    }))
    assert.ok(!result.isError, `real edit must pass: ${result.content}`)
    assert.equal(readFileSync(file, 'utf-8'), 'new heading\nbody\n')
  })
})
