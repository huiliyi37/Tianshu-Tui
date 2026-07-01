import { test } from 'node:test'
import assert from 'node:assert/strict'
import { splitUnifiedDiffByFile } from '../split-diff.ts'

const TWO_FILE_DIFF = `diff --git a/src/foo.ts b/src/foo.ts
index 1111111..2222222 100644
--- a/src/foo.ts
+++ b/src/foo.ts
@@ -1,3 +1,4 @@
 const a = 1
+const b = 2
 const c = 3
diff --git a/src/bar.ts b/src/bar.ts
index 3333333..4444444 100644
--- a/src/bar.ts
+++ b/src/bar.ts
@@ -10,2 +10,2 @@
-old line
+new line`

test('splits a multi-file diff into one chunk per file', () => {
  const files = splitUnifiedDiffByFile(TWO_FILE_DIFF)
  assert.equal(files.length, 2)
  assert.equal(files[0]!.path, 'src/foo.ts')
  assert.equal(files[1]!.path, 'src/bar.ts')
})

test('each chunk retains its diff --git and +++ headers (for DiffView anchors)', () => {
  const files = splitUnifiedDiffByFile(TWO_FILE_DIFF)
  assert.ok(files[0]!.patch.startsWith('diff --git a/src/foo.ts b/src/foo.ts'))
  assert.ok(files[0]!.patch.includes('+++ b/src/foo.ts'))
  assert.ok(files[1]!.patch.includes('@@ -10,2 +10,2 @@'))
  // The second chunk must NOT leak the first file's lines.
  assert.ok(!files[1]!.patch.includes('src/foo.ts'))
})

test('resolves path for added files (--- /dev/null) from the new side', () => {
  const added = `diff --git a/new.ts b/new.ts
new file mode 100644
index 0000000..5555555
--- /dev/null
+++ b/new.ts
@@ -0,0 +1,2 @@
+line one
+line two`
  const files = splitUnifiedDiffByFile(added)
  assert.equal(files.length, 1)
  assert.equal(files[0]!.path, 'new.ts')
})

test('resolves path for deleted files (+++ /dev/null) from the old side', () => {
  const deleted = `diff --git a/gone.ts b/gone.ts
deleted file mode 100644
index 6666666..0000000
--- a/gone.ts
+++ /dev/null
@@ -1,2 +0,0 @@
-line one
-line two`
  const files = splitUnifiedDiffByFile(deleted)
  assert.equal(files.length, 1)
  assert.equal(files[0]!.path, 'gone.ts')
})

test('returns empty array for empty input', () => {
  assert.deepEqual(splitUnifiedDiffByFile(''), [])
})

test('ignores preamble before the first diff --git header', () => {
  const withPreamble = `Some git notice\n${TWO_FILE_DIFF}`
  const files = splitUnifiedDiffByFile(withPreamble)
  assert.equal(files.length, 2)
  assert.equal(files[0]!.path, 'src/foo.ts')
})
