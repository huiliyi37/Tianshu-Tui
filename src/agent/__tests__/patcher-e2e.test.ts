import { describe, it, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, readFileSync, rmSync, existsSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { spawnSync } from 'node:child_process'
import { collectDiff, formatDiffArtifact } from '../diff-collector.js'
import { materializeScope } from '../worktree-scope.js'
import { verifyWorkerEvidence } from '../worker-evidence.js'
import { buildPrimaryWorkerPacket } from '../worker-prompts.js'
import { applyPatch } from '../../tools/apply-patch.js'

function git(cwd: string, args: string[]) {
  return spawnSync('git', args, { cwd, encoding: 'utf-8', stdio: ['ignore', 'pipe', 'pipe'] })
}

describe('patcher e2e: untracked scope → worktree edit → diff → apply', () => {
  let repoDir: string
  let wtDir: string

  beforeEach(() => {
    repoDir = mkdtempSync(join(tmpdir(), 'e2e-repo-'))
    git(repoDir, ['init', '-b', 'main'])
    git(repoDir, ['config', 'user.email', 'test@test.com'])
    git(repoDir, ['config', 'user.name', 'Test'])
    mkdirSync(join(repoDir, 'src'), { recursive: true })
    mkdirSync(join(repoDir, 'docs'), { recursive: true })
    writeFileSync(join(repoDir, 'src', 'app.ts'), 'export const broken = true\n')
    git(repoDir, ['add', '.'])
    git(repoDir, ['commit', '-m', 'init'])
    writeFileSync(join(repoDir, 'docs', 'plan.md'), '# Fix broken\n')

    wtDir = mkdtempSync(join(tmpdir(), 'e2e-wt-'))
    rmSync(wtDir, { recursive: true })
    git(repoDir, ['worktree', 'add', '-b', 'patch-branch', wtDir])
  })

  afterEach(() => {
    git(repoDir, ['worktree', 'remove', '--force', wtDir])
    rmSync(repoDir, { recursive: true, force: true })
  })

  it('full patcher lifecycle produces applicable patch', async () => {
    const scope = materializeScope(repoDir, wtDir, ['docs/plan.md', 'src/app.ts'])
    assert.ok(existsSync(join(wtDir, 'docs', 'plan.md')), 'plan.md materialized')
    assert.equal(scope.missing.length, 0)

    writeFileSync(join(wtDir, 'src', 'app.ts'), 'export const broken = false\n')

    const diff = collectDiff(repoDir, wtDir, 'main')
    assert.ok(diff.includes('broken = false'), 'diff captures worker edit')

    const artifact = formatDiffArtifact(diff, 'patcher')
    assert.equal(artifact.kind, 'diff')
    assert.ok(artifact.content.length > 10, 'artifact not empty')
    assert.ok(!artifact.content.endsWith('…'), 'artifact not truncated')

    const workerResult = {
      workOrderId: 'test-order',
      status: 'passed' as const,
      summary: 'fixed broken flag',
      findings: [],
      artifacts: [artifact],
      changedFiles: ['src/app.ts'],
      examinedFiles: ['docs/plan.md'],
      risks: [],
      nextActions: [],
      evidenceStatus: 'unverified' as const,
    }
    const gated = verifyWorkerEvidence(workerResult, 'patcher')
    assert.notEqual(gated.status, 'blocked', 'patcher should not be blocked')
    assert.ok(gated.risks.some(r => r.includes('advisory')), 'patcher gets advisory risk')

    const packet = buildPrimaryWorkerPacket([gated])
    assert.ok(packet.includes('broken = false'), 'packet preserves diff content')

    const check = await applyPatch(repoDir, { diff, checkOnly: true })
    assert.equal(check.ok, true, check.error)

    const applied = await applyPatch(repoDir, { diff })
    assert.equal(applied.ok, true, applied.error)
    assert.equal(
      readFileSync(join(repoDir, 'src', 'app.ts'), 'utf-8').trim(),
      'export const broken = false',
    )
  })
})
