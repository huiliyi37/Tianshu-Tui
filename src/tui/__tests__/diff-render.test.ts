import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { isDiffContent } from '../diff-render.js'

describe('isDiffContent', () => {
  it('detects unified diff', () => {
    const text = `--- a/src/file.ts
+++ b/src/file.ts
@@ -1,3 +1,4 @@
 import { x } from 'y'
+Import { z } from 'w'
 const a = 1`
    assert.equal(isDiffContent(text), true)
  })

  it('detects git diff format', () => {
    const text = `diff --git a/file.ts b/file.ts
index abc..def 100644
--- a/file.ts
+++ b/file.ts
@@ -1 +1 @@
-old
+new`
    assert.equal(isDiffContent(text), true)
  })

  it('does not match plain text', () => {
    assert.equal(isDiffContent('hello world\nsome output'), false)
  })

  it('does not match text with just + lines', () => {
    assert.equal(isDiffContent('some output\n+ just a plus sign'), false)
  })

  it('detects diff with only hunk markers', () => {
    const text = `@@ -1,3 +1,3 @@
-old
+new
 context`
    assert.equal(isDiffContent(text), true)
  })
})
