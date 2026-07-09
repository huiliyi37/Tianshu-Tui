import { describe, it, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { spawnSync } from 'node:child_process'
import { applyPatch, APPLY_PATCH_TOOL, extractPatchTargetPaths } from '../apply-patch.js'

function git(cwd: string, args: string[]) {
  return spawnSync('git', args, { cwd, encoding: 'utf-8', stdio: ['ignore', 'pipe', 'pipe'] })
}

describe('applyPatch', () => {
  let repoDir: string
  const validDiff = `diff --git a/file.txt b/file.txt
index 2e65efe..a2005b8 100644
--- a/file.txt
+++ b/file.txt
@@ -1 +1 @@
-original
+patched
`

  beforeEach(() => {
    repoDir = mkdtempSync(join(tmpdir(), 'patch-test-'))
    git(repoDir, ['init', '-b', 'main'])
    git(repoDir, ['config', 'user.email', 'test@test.com'])
    git(repoDir, ['config', 'user.name', 'Test'])
    writeFileSync(join(repoDir, 'file.txt'), 'original\n')
    git(repoDir, ['add', '.'])
    git(repoDir, ['commit', '-m', 'init'])
  })

  afterEach(() => {
    rmSync(repoDir, { recursive: true, force: true })
  })

  it('applies valid patch', async () => {
    const result = await applyPatch(repoDir, { diff: validDiff })
    assert.equal(result.ok, true, result.error)
    assert.equal(readFileSync(join(repoDir, 'file.txt'), 'utf-8').trim(), 'patched')
  })

  it('check-only mode does not modify files', async () => {
    const result = await applyPatch(repoDir, { diff: validDiff, checkOnly: true })
    assert.equal(result.ok, true, result.error)
    assert.equal(readFileSync(join(repoDir, 'file.txt'), 'utf-8').trim(), 'original')
  })

  it('returns error for conflicting patch', async () => {
    writeFileSync(join(repoDir, 'file.txt'), 'already changed\n')
    const result = await applyPatch(repoDir, { diff: validDiff })
    assert.equal(result.ok, false)
    assert.ok(
      /patch does not apply|does not match index|repository lacks the necessary blob|和索引不匹配/i.test(result.error),
      result.error,
    )
  })

  it('successful apply echoes the diff into uiContent (display-only)', async () => {
    const result = await APPLY_PATCH_TOOL.execute({
      input: { diff: validDiff },
      toolUseId: 'toolu_test',
      cwd: repoDir,
    })
    assert.ok(!result.isError, result.content)
    // model-facing content stays a short summary
    assert.equal(result.content, 'Patch applied successfully.')
    // display-only uiContent carries the diff for colored rendering
    assert.ok(result.uiContent && /^@@/m.test(result.uiContent), 'uiContent has hunk header')
    assert.ok(/^-original$/m.test(result.uiContent!))
    assert.ok(/^\+patched$/m.test(result.uiContent!))
  })

  it('tool validates non-empty diff input', async () => {
    const result = await APPLY_PATCH_TOOL.execute({
      input: { diff: '' },
      toolUseId: 'toolu_test',
      cwd: repoDir,
    })

    assert.equal(result.isError, true)
    assert.match(result.content, /requires a non-empty/)
  })

  it('normalizes Windows-style backslash paths in diff headers', async () => {
    const windowsDiff = validDiff.replace(/a\/file\.txt/g, 'a\\file.txt').replace(/b\/file\.txt/g, 'b\\file.txt')
    const result = await APPLY_PATCH_TOOL.execute({
      input: { diff: windowsDiff },
      toolUseId: 'toolu_test',
      cwd: repoDir,
    })
    assert.ok(!result.isError, result.content)
    assert.ok(result.uiContent!.includes('--- a/file.txt'), 'header path was normalized')
    assert.ok(result.uiContent!.includes('+++ b/file.txt'), 'header path was normalized')
    assert.equal(readFileSync(join(repoDir, 'file.txt'), 'utf-8').trim(), 'patched')
  })

  it('rejects a collapsed history pointer as diff input', async () => {
    const result = await APPLY_PATCH_TOOL.execute({
      input: { diff: '[patch applied to 2 file(s): a.py, b.py — 4 hunks, 9000 chars. Use read_file / git diff to inspect.]' },
      toolUseId: 'toolu_test',
      cwd: repoDir,
    })
    assert.equal(result.isError, true)
    assert.match(result.content, /collapsed history pointer/i)
  })

  it('rolls back a patch that introduces a fatal Python syntax error', async () => {
    writeFileSync(join(repoDir, 'mod.py'), 'def foo():\n    return 1\n')
    git(repoDir, ['add', 'mod.py'])
    git(repoDir, ['commit', '-m', 'add mod'])
    // Patch turns a valid def into an unbalanced one — python3 ast.parse fails.
    const badDiff = `diff --git a/mod.py b/mod.py
--- a/mod.py
+++ b/mod.py
@@ -1,2 +1,2 @@
-def foo():
+def foo(:
     return 1
`
    const result = await APPLY_PATCH_TOOL.execute({
      input: { diff: badDiff },
      toolUseId: 'toolu_test',
      cwd: repoDir,
    })
    // If python3 is unavailable, syntax check degrades to OK and the patch
    // stays applied — only assert rollback when the corruption was detected.
    if (result.isError) {
      assert.match(result.content, /rolled back/i)
      assert.equal(readFileSync(join(repoDir, 'mod.py'), 'utf-8'), 'def foo():\n    return 1\n')
    }
  })

  it('extractPatchTargetPaths parses +++ headers and skips /dev/null', () => {
    const diff = `diff --git a/x.ts b/x.ts
--- a/x.ts
+++ b/x.ts
@@ -1 +1 @@
-a
+b
diff --git a/gone.txt b/gone.txt
--- a/gone.txt
+++ /dev/null
@@ -1 +0,0 @@
-bye
`
    assert.deepEqual(extractPatchTargetPaths(diff), ['x.ts'])
  })

  it('truncates oversized diffs in uiContent', async () => {
    const bigFile = join(repoDir, 'big.txt')
    const beforeLines = Array.from({ length: 1200 }, (_, i) => `line-${i}`)
    writeFileSync(bigFile, beforeLines.join('\n') + '\n')
    git(repoDir, ['add', 'big.txt'])
    git(repoDir, ['commit', '-m', 'add big'])
    const afterLines = beforeLines.map(l => `patched-${l}`)
    const hunks = beforeLines.map((l, i) => `-${l}\n+${afterLines[i]}`).join('\n')
    const bigDiff = `diff --git a/big.txt b/big.txt\n--- a/big.txt\n+++ b/big.txt\n@@ -1,1200 +1,1200 @@\n${hunks}\n`
    const result = await APPLY_PATCH_TOOL.execute({
      input: { diff: bigDiff },
      toolUseId: 'toolu_test',
      cwd: repoDir,
    })
    assert.ok(!result.isError, result.content)
    const lines = result.uiContent!.split('\n')
    assert.ok(lines.length <= 602, `expected truncation, got ${lines.length} lines`)
    assert.ok(result.uiContent!.includes('more diff lines, Ctrl+O'))
  })
})
