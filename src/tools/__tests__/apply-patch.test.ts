import { describe, it, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { spawnSync } from 'node:child_process'
import { applyPatch, APPLY_PATCH_TOOL } from '../apply-patch.js'

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

  it('tool validates non-empty diff input', async () => {
    const result = await APPLY_PATCH_TOOL.execute({
      input: { diff: '' },
      toolUseId: 'toolu_test',
      cwd: repoDir,
    })

    assert.equal(result.isError, true)
    assert.match(result.content, /requires a non-empty/)
  })
})
