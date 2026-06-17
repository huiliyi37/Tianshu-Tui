import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  applyPatchArgProcessor,
  APPLY_PATCH_POINTER_PREFIX,
  APPLY_PATCH_THRESHOLD,
} from '../apply-patch-arg-processor.js'

/** Build a unified diff that touches `fileCount` files and exceeds the threshold. */
function makeDiff(fileCount: number): string {
  const body = 'context line\n'.repeat(Math.ceil(APPLY_PATCH_THRESHOLD / 13))
  let out = ''
  for (let i = 0; i < fileCount; i++) {
    out += `--- a/src/file${i}.ts\n+++ b/src/file${i}.ts\n@@ -1,3 +1,3 @@\n-old\n+new\n${body}`
  }
  return out
}

describe('applyPatchArgProcessor', () => {
  it('collapses a large multi-file diff into a file-list pointer', () => {
    const diff = makeDiff(3)
    const args = JSON.stringify({ diff })
    const result = applyPatchArgProcessor.process(args)
    assert.ok(result)
    const parsed = JSON.parse(result!)
    assert.ok((parsed.diff as string).startsWith(APPLY_PATCH_POINTER_PREFIX))
    assert.ok((parsed.diff as string).includes('3 file(s)'))
    assert.ok((parsed.diff as string).includes('src/file0.ts'))
    assert.ok((parsed.diff as string).includes('hunks'))
    assert.ok((parsed.diff as string).includes(`${diff.length} chars`))
    // verbatim diff body must be gone
    assert.ok(!(parsed.diff as string).includes('context line\ncontext line'))
  })

  it('truncates the file list beyond 5 with an overflow marker', () => {
    const parsed = JSON.parse(applyPatchArgProcessor.process(JSON.stringify({ diff: makeDiff(8) }))!)
    assert.ok((parsed.diff as string).includes('8 file(s)'))
    assert.ok((parsed.diff as string).includes('…(+3)'))
  })

  it('leaves check_only diffs inline (model needs the diff to fix)', () => {
    const args = JSON.stringify({ diff: makeDiff(3), check_only: true })
    assert.equal(applyPatchArgProcessor.process(args), null)
  })

  it('leaves small diffs inline (below threshold)', () => {
    const small = '--- a/x.ts\n+++ b/x.ts\n@@ -1 +1 @@\n-a\n+b\n'
    assert.equal(applyPatchArgProcessor.process(JSON.stringify({ diff: small })), null)
  })

  it('returns null when no file headers can be parsed', () => {
    const garbage = 'x'.repeat(APPLY_PATCH_THRESHOLD + 100)
    assert.equal(applyPatchArgProcessor.process(JSON.stringify({ diff: garbage })), null)
  })

  it('skips /dev/null targets (pure deletions) when listing files', () => {
    const body = 'y\n'.repeat(APPLY_PATCH_THRESHOLD)
    const diff = `--- a/gone.ts\n+++ /dev/null\n@@ -1,2 +0,0 @@\n-a\n-b\n--- a/kept.ts\n+++ b/kept.ts\n@@ -1 +1 @@\n-a\n+b\n${body}`
    const parsed = JSON.parse(applyPatchArgProcessor.process(JSON.stringify({ diff }))!)
    assert.ok((parsed.diff as string).includes('kept.ts'))
    assert.ok(!(parsed.diff as string).includes('/dev/null'))
    assert.ok((parsed.diff as string).includes('1 file(s)'))
  })

  it('is idempotent — re-processing returns null', () => {
    const once = applyPatchArgProcessor.process(JSON.stringify({ diff: makeDiff(2) }))
    assert.ok(once)
    assert.equal(applyPatchArgProcessor.process(once!), null)
  })

  it('returns null on invalid JSON (fail-open)', () => {
    assert.equal(applyPatchArgProcessor.process('}{'), null)
  })

  it('result is valid JSON', () => {
    JSON.parse(applyPatchArgProcessor.process(JSON.stringify({ diff: makeDiff(2) }))!)
  })

  it('preserves check_only:false and other fields', () => {
    const parsed = JSON.parse(applyPatchArgProcessor.process(JSON.stringify({ diff: makeDiff(2), check_only: false }))!)
    assert.equal(parsed.check_only, false)
  })
})
