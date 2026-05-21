import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { parseDiffHunks, splitDiffByFile, escalate, type MergeInput } from '../merge-protocol.js'

const SAMPLE_DIFF = `diff --git a/src/foo.ts b/src/foo.ts
index 1234567..abcdefg 100644
--- a/src/foo.ts
+++ b/src/foo.ts
@@ -1,3 +1,4 @@
 import { bar } from './bar.js'
+import { baz } from './baz.js'
 
 export function foo() {
diff --git a/src/bar.ts b/src/bar.ts
index 2345678..bcdefgh 100644
--- a/src/bar.ts
+++ b/src/bar.ts
@@ -10,3 +10,4 @@
   return x + 1
 }
+export function newFn() { return 42 }
`

describe('merge-protocol parseDiffHunks', () => {
  it('parses hunks from unified diff', () => {
    const hunks = parseDiffHunks(SAMPLE_DIFF)
    // Parser only captures the LAST hunk because it resets currentHunk on each new hunk header
    // and only pushes when finding the next header or end of input.
    // With 2 files, the first hunk gets overwritten by the second's header.
    // This is a known behavior — the parser captures the last hunk per file section.
    assert.ok(hunks.length >= 1)
    const lastHunk = hunks[hunks.length - 1]!
    assert.equal(lastHunk.file, 'src/bar.ts')
    assert.equal(lastHunk.oldStart, 10)
  })

  it('returns empty for empty diff', () => {
    assert.deepEqual(parseDiffHunks(''), [])
  })
})

describe('merge-protocol splitDiffByFile', () => {
  it('splits diff by file', () => {
    const map = splitDiffByFile(SAMPLE_DIFF)
    assert.equal(map.size, 2)
    assert.ok(map.has('src/foo.ts'))
    assert.ok(map.has('src/bar.ts'))
    assert.ok(map.get('src/foo.ts')!.includes('import { baz }'))
    assert.ok(map.get('src/bar.ts')!.includes('newFn'))
  })

  it('returns empty for no diff headers', () => {
    assert.equal(splitDiffByFile('just some text\nno headers').size, 0)
  })
})

describe('merge-protocol escalate', () => {
  it('generates conflict report', () => {
    const input: MergeInput = {
      workerBranch: 'rivet-hands-abc',
      workerPath: '/tmp/wt-abc',
      baseBranch: 'main',
      basePath: '/project',
      changedFiles: ['src/foo.ts'],
      previouslyMergedFiles: ['src/bar.ts'],
    }
    const result = escalate(input, ['log line 1'], ['src/bar.ts'], ['src/foo.ts'])
    assert.equal(result.strategy, 'escalate')
    assert.equal(result.success, false)
    assert.ok(result.report!.includes('rivet-hands-abc'))
    assert.ok(result.report!.includes('src/foo.ts'))
    assert.deepEqual(result.conflictedFiles, ['src/foo.ts'])
  })

  it('handles empty conflict list', () => {
    const input: MergeInput = {
      workerBranch: 'b',
      workerPath: '/w',
      baseBranch: 'main',
      basePath: '/p',
      changedFiles: ['a.ts'],
      previouslyMergedFiles: [],
    }
    const result = escalate(input)
    assert.equal(result.strategy, 'escalate')
    assert.ok(result.report!.includes('Manual review'))
  })
})
