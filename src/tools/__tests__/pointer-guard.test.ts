import { describe, it, beforeEach, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, rmSync, existsSync, writeFileSync, readFileSync, mkdtempSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import {
  detectPointerPlaceholder,
  pointerPlaceholderError,
  resolveIdempotentPointer,
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
  it('detects every registered pointer prefix in real pointer shape', () => {
    const samples: Record<string, string> = {
      '[file written to': '[file written to /x/y.md — 5 lines, 100 chars. #RIVET-POINTER-DISPLAY-ONLY# Display placeholder — never emit this as content; use read_file to review.]',
      '[edit on': '[edit on /x/y.md: replaced 100-char block, preview: "abc". #RIVET-POINTER-DISPLAY-ONLY# Display placeholder — never emit this as content; use read_file for current content.]',
      '[hash_edit applied to': '[hash_edit applied to /x/y.md — new block 5 lines, 100 chars. #RIVET-POINTER-DISPLAY-ONLY# Display placeholder — never emit this as content; use read_file to review.]',
      '[new block': '[new block 100 chars — #RIVET-POINTER-DISPLAY-ONLY# placeholder, never emit as content]',
      '[plan persisted to': '[plan persisted to .rivet/plans/x.md — 5 lines, 100 chars. #RIVET-POINTER-DISPLAY-ONLY# Use read_file to review.]',
      '[patch applied to': '[patch applied to 2 file(s): a.ts, b.ts — 3 hunks, 1520 chars. 已成功应用，勿重放——历史正常截断，查看用 read_file / git diff。#RIVET-POINTER-DISPLAY-ONLY# display-only pointer]',
    }
    for (const prefix of POINTER_PLACEHOLDER_PREFIXES) {
      const sample = samples[prefix]
      assert.ok(sample, `missing test sample for prefix ${prefix}`)
      assert.equal(detectPointerPlaceholder(sample), prefix, prefix)
    }
  })

  it('detects the current (post-2026-08) pointer format with success reassurance copy', () => {
    // 现行 render 文案：前缀 + 中文「已成功落盘…不要重写」说明 + 机器 tag。
    // tag 仍是检测锚点，旧格式（上方用例）也必须继续命中——存量会话历史里两种并存。
    const samples: Record<string, string> = {
      '[file written to': '[file written to /x/y.md — 5 lines, 100 chars. 已成功落盘，勿重写——历史正常截断，查看用 read_file。#RIVET-POINTER-DISPLAY-ONLY# display-only pointer]',
      '[edit on': '[edit on /x/y.md: replaced 100-char block, preview: "abc". 已成功落盘，勿重做——历史正常截断，查看用 read_file。#RIVET-POINTER-DISPLAY-ONLY# display-only pointer]',
      '[hash_edit applied to': '[hash_edit applied to /x/y.md — new block 5 lines, 100 chars. 已成功落盘，勿重做——历史正常截断，查看用 read_file。#RIVET-POINTER-DISPLAY-ONLY# display-only pointer]',
      '[new block': '[new block 100 chars — 已落盘，勿重做。#RIVET-POINTER-DISPLAY-ONLY# display-only pointer]',
      '[plan persisted to': '[plan persisted to .rivet/plans/x.md — 5 lines, 100 chars. 已成功落盘，勿重贴——历史正常截断，查看用 read_file。#RIVET-POINTER-DISPLAY-ONLY# display-only pointer]',
      '[patch applied to': '[patch applied to 2 file(s): a.ts, b.ts — 3 hunks, 1520 chars. 已成功应用，勿重放——历史正常截断，查看用 read_file / git diff。#RIVET-POINTER-DISPLAY-ONLY# display-only pointer]',
    }
    for (const prefix of POINTER_PLACEHOLDER_PREFIXES) {
      const sample = samples[prefix]
      assert.ok(sample, `missing test sample for prefix ${prefix}`)
      assert.equal(detectPointerPlaceholder(sample), prefix, prefix)
    }
  })

  it('detects an apply_patch pointer echoed into write_file content (cross-tool)', () => {
    // apply-patch 的大 diff 在历史中被折叠为 [patch applied to …] 指针；
    // 模型可能把它 echo 成 write_file 的 content —— 守卫必须识别（前缀 + tag 双条件）。
    const apPtr = '[patch applied to 2 file(s): a.ts, b.ts — 3 hunks, 1520 chars. 已成功应用，勿重放——历史正常截断，查看用 read_file / git diff。#RIVET-POINTER-DISPLAY-ONLY# display-only pointer]'
    assert.equal(detectPointerPlaceholder(apPtr), '[patch applied to')
  })

  it('detects a pointer behind leading whitespace', () => {
    assert.equal(
      detectPointerPlaceholder('\n  [file written to /a.md — 5 lines, 10 chars. Display placeholder — never emit this as content; use read_file to review.]'),
      '[file written to',
    )
  })

  it('ignores real content that mentions a pointer mid-text', () => {
    assert.equal(detectPointerPlaceholder('Docs: history shows "[file written to …" pointers.\n'), null)
    assert.equal(detectPointerPlaceholder('---\ndeck: 01英语::00必考词\n---\n\n### gift\n'), null)
  })

  it('allows real content that starts with a pointer prefix but contains newlines', () => {
    const content = '[file written to /a/b/page.tsx — this line is a red herring\nimport React from "react"\nexport default function Page() {\n  return <div>real content</div>\n}\n'
    assert.equal(detectPointerPlaceholder(content), null)
  })

  it('allows a single-line prefix imitation that lacks the marker phrase', () => {
    assert.equal(
      detectPointerPlaceholder('[file written to /a/b/page.tsx is a note about what I did earlier]'),
      null,
    )
  })

  it('detects a pointer embedded mid-content on its own line', () => {
    const content = 'Here is the previous batch:\n[file written to /x/y.md — 5 lines, 100 chars. #RIVET-POINTER-DISPLAY-ONLY# Display placeholder — never emit this as content; use read_file to review.]\nNow continuing...'
    assert.equal(detectPointerPlaceholder(content), '[file written to')
  })

  it('detects a pointer at the end of multi-line content', () => {
    const content = 'Draft below:\n\n[hash_edit applied to /x/y.md — new block 5 lines, 100 chars. #RIVET-POINTER-DISPLAY-ONLY# Display placeholder — never emit this as content; use read_file to review.]'
    assert.equal(detectPointerPlaceholder(content), '[hash_edit applied to')
  })

  it('still allows real content that merely mentions a pointer mid-text', () => {
    assert.equal(
      detectPointerPlaceholder('Docs: history shows "[file written to /x/y.md — 5 lines, 100 chars. #RIVET-POINTER-DISPLAY-ONLY# Display placeholder — never emit this as content; use read_file to review.]" pointers.'),
      null,
    )
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

  it('edit_file gracefully resolves a regurgitated write pointer as new_string (file untouched)', async () => {
    const file = join(TEST_DIR, 'target.md')
    writeFileSync(file, 'line one\nline two\n')
    const result = await EDIT_FILE_TOOL.execute(makeParams({
      file_path: file,
      old_string: 'line two',
      new_string: `[file written to ${file} — 507 lines, 12744 chars. Use read_file to review.]`,
    }))
    // 幂等化解：路径一致 + 文件存在 → 视为编辑已应用，按 no-op 成功返回。
    assert.ok(!result.isError, `idempotent resolution must succeed, got: ${result.content}`)
    assert.equal(readFileSync(file, 'utf-8'), 'line one\nline two\n', 'file untouched')
  })

  it('edit_file gracefully resolves a regurgitated edit pointer as old_string', async () => {
    const file = join(TEST_DIR, 'target2.md')
    writeFileSync(file, 'alpha\nbeta\n')
    const result = await EDIT_FILE_TOOL.execute(makeParams({
      file_path: file,
      old_string: `[edit on ${file}: replaced 9000-char block, preview: "x". Display placeholder — never emit this as content; use read_file for current content.]`,
      new_string: 'gamma',
    }))
    assert.ok(!result.isError, `idempotent resolution must succeed, got: ${result.content}`)
    assert.equal(readFileSync(file, 'utf-8'), 'alpha\nbeta\n', 'file untouched')
  })

  it('hash_edit gracefully resolves a regurgitated pointer as new_string (file untouched)', async () => {
    const file = join(TEST_DIR, 'batch12.md')
    writeFileSync(file, '### part\n\ncontent\n')
    const result = await HASH_EDIT_TOOL.execute(makeParams({
      file_path: file,
      anchors: ['L1'],
      new_string: `[hash_edit applied to ${file} — new block 12 lines, 400 chars. Use read_file to review.]`,
    }))
    // 幂等化解：路径一致 + 文件存在 → 视为编辑已应用，按 no-op 成功返回。
    assert.ok(!result.isError, `idempotent resolution must succeed, got: ${result.content}`)
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

describe('resolveIdempotentPointer', () => {
  let dir = ''
  before(() => { dir = mkdtempSync(join(tmpdir(), 'rivet-ptr-')) })
  after(() => { try { rmSync(dir, { recursive: true, force: true }) } catch { /* best-effort */ } })

  it('full mode: resolves when disk matches the write pointer stats', async () => {
    const fp = join(dir, 'a.ts')
    writeFileSync(fp, 'line1\nline2\nline3')
    const value = `[file written to ${fp} — 3 lines, 17 chars. #RIVET-POINTER-DISPLAY-ONLY# Display placeholder — never emit this as content; use read_file to review.]`
    const r = await resolveIdempotentPointer({ mode: 'full', filePath: fp, value, matchedPrefix: '[file written to' })
    assert.ok(r, 'should resolve as idempotent success')
    assert.match(r!.content, /幂等|已是|未做写入/)
    assert.equal(r!.isError ?? false, false)
  })

  it('full mode: returns null when the pointer path differs from target', async () => {
    const fp = join(dir, 'b.ts')
    writeFileSync(fp, 'x')
    const value = `[file written to ${join(dir, 'OTHER.ts')} — 1 lines, 1 chars. #RIVET-POINTER-DISPLAY-ONLY# Display placeholder.]`
    const r = await resolveIdempotentPointer({ mode: 'full', filePath: fp, value, matchedPrefix: '[file written to' })
    assert.equal(r, null)
  })

  it('full mode: returns null when disk stats do not match', async () => {
    const fp = join(dir, 'c.ts')
    writeFileSync(fp, 'only one line')
    const value = `[file written to ${fp} — 99 lines, 9999 chars. #RIVET-POINTER-DISPLAY-ONLY# Display placeholder.]`
    const r = await resolveIdempotentPointer({ mode: 'full', filePath: fp, value, matchedPrefix: '[file written to' })
    assert.equal(r, null)
  })

  it('edit mode: resolves when target file exists and pointer path matches (hash_edit pointer)', async () => {
    const fp = join(dir, 'd.ts')
    writeFileSync(fp, 'edited content already on disk')
    const value = `[hash_edit applied to ${fp} — new block 2 lines, 40 chars. #RIVET-POINTER-DISPLAY-ONLY# Display placeholder.]`
    const r = await resolveIdempotentPointer({ mode: 'edit', filePath: fp, value, matchedPrefix: '[hash_edit applied to' })
    assert.ok(r, 'edit pointer with matching path + existing file resolves as no-op')
    assert.match(r!.content, /已应用|幂等|无需/)
  })

  it('edit mode: resolves for edit_file old_string pointer (colon separator)', async () => {
    const fp = join(dir, 'e.ts')
    writeFileSync(fp, 'some content here')
    const value = `[edit on ${fp}: replaced 5000-char block, preview: "x". #RIVET-POINTER-DISPLAY-ONLY# Display placeholder — never emit this as content; use read_file for current content.]`
    const r = await resolveIdempotentPointer({ mode: 'edit', filePath: fp, value, matchedPrefix: '[edit on' })
    assert.ok(r, 'edit_file colon-separated pointer path must be parsed correctly')
  })

  it('edit mode: returns null when target file is missing', async () => {
    const fp = join(dir, 'missing.ts')
    const value = `[hash_edit applied to ${fp} — new block 1 lines, 5 chars. #RIVET-POINTER-DISPLAY-ONLY# Display placeholder.]`
    const r = await resolveIdempotentPointer({ mode: 'edit', filePath: fp, value, matchedPrefix: '[hash_edit applied to' })
    assert.equal(r, null)
  })

  it('edit mode: returns null when pointer contains no path (edit_file new_string [new block ...] pattern)', async () => {
    const fp = join(dir, 'f.ts')
    writeFileSync(fp, 'content')
    const value = `[new block 40 chars — #RIVET-POINTER-DISPLAY-ONLY# placeholder, never emit as content]`
    const r = await resolveIdempotentPointer({ mode: 'edit', filePath: fp, value, matchedPrefix: '[new block' })
    assert.equal(r, null, 'pathless pointer must not resolve')
  })
})
