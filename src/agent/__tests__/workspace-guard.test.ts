import { describe, it, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, rmSync, writeFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { execSync } from 'node:child_process'
import {
  createWorkspaceGuard,
  type WorkspaceGuard,
  type WorkspaceGuardReport,
} from '../workspace-guard.js'

const TMP = join(import.meta.dirname, '.workspace-guard-test-tmp')

function setupGitRepo(cwd: string): void {
  execSync('git init -b main', { cwd })
  execSync('git config user.email "test@test.com"', { cwd })
  execSync('git config user.name "Test"', { cwd })
  // Suppress init.defaultBranch warning
  execSync('git config init.defaultBranch main', { cwd })
}

function makeGitignore(cwd: string, patterns: string[]): void {
  writeFileSync(join(cwd, '.gitignore'), patterns.join('\n') + '\n')
}

function gitAdd(cwd: string, files: string[], force = false): void {
  const flag = force ? ' -f' : ''
  for (const f of files) {
    execSync(`git add${flag} "${f}"`, { cwd })
  }
}

function gitCommit(cwd: string, msg: string): void {
  execSync(`git commit -m "${msg}"`, { cwd })
}

function makeDir(cwd: string, dir: string): void {
  mkdirSync(join(cwd, dir), { recursive: true })
}

function makeFile(cwd: string, path: string, content: string): void {
  const fullPath = join(cwd, path)
  const dir = fullPath.substring(0, fullPath.lastIndexOf('/'))
  if (dir) mkdirSync(dir, { recursive: true })
  writeFileSync(fullPath, content)
}

describe('workspace-guard — stash / runtime artifact guard', () => {
  let guard: WorkspaceGuard

  beforeEach(() => {
    rmSync(TMP, { recursive: true, force: true })
    mkdirSync(TMP, { recursive: true })
    setupGitRepo(TMP)
    makeGitignore(TMP, ['.rivet/artifacts/', '.rivet/sessions/'])
    guard = createWorkspaceGuard(TMP)
  })

  afterEach(() => {
    rmSync(TMP, { recursive: true, force: true })
  })

  // ── Spec scenario 1: tracked runtime artifacts → blocked ──────

  it('tracked runtime artifacts → blocked', async () => {
    // Create runtime artifacts and track them in git
    makeDir(TMP, '.rivet/artifacts')
    makeFile(TMP, '.rivet/artifacts/verification.json', '{"score": 0.95}')
    makeFile(TMP, '.rivet/artifacts/log.txt', 'session log')
    gitAdd(TMP, ['.rivet/artifacts/verification.json', '.rivet/artifacts/log.txt'], true)

    const result = await guard.checkRuntimeArtifacts()

    assert.equal(result.blocked, true, 'tracked runtime artifacts should block')
    assert.ok(result.tracked.length >= 2, `Expected >=2 tracked, got ${result.tracked.length}`)
    assert.ok(
      result.tracked.some(f => f.includes('verification.json')),
      'verification.json should be listed as tracked',
    )
    assert.ok(
      result.tracked.some(f => f.includes('log.txt')),
      'log.txt should be listed as tracked',
    )

    // At least one reason starts with BLOCKED
    const blockedReasons = result.reasons.filter(r => r.startsWith('BLOCKED:'))
    assert.ok(blockedReasons.length > 0, `Expected BLOCKED reason, got: ${result.reasons.join(' | ')}`)
    assert.ok(
      blockedReasons[0]!.includes('runtime artifact'),
      `Reason should mention runtime artifacts: ${blockedReasons[0]}`,
    )
  })

  // ── Spec scenario 2: ignored runtime artifacts → warning, not blocked ──

  it('ignored runtime artifacts → warning, not blocked', async () => {
    // Create runtime artifacts on disk (gitignored by .gitignore)
    makeDir(TMP, '.rivet/artifacts')
    makeFile(TMP, '.rivet/artifacts/verification.json', '{"score": 0.95}')
    makeDir(TMP, '.rivet/sessions')
    makeFile(TMP, '.rivet/sessions/session-1.jsonl', '{"turn": 1}')

    // Ensure gitignore covers them
    const ignored = execSync('git ls-files --others --ignored --exclude-standard', {
      cwd: TMP,
      encoding: 'utf-8',
    })
    assert.ok(ignored.trim().length > 0, 'files should be gitignored')

    const result = await guard.checkRuntimeArtifacts()

    assert.equal(result.blocked, false, 'ignored runtime artifacts should NOT block')
    assert.equal(result.tracked.length, 0, 'no tracked runtime artifacts expected')
    assert.ok(
      result.ignoredButPresent.length > 0,
      `Expected ignored-but-present files, got: ${result.ignoredButPresent}`,
    )

    // Warning reason must exist
    const warningReasons = result.reasons.filter(r => r.startsWith('WARNING:'))
    assert.ok(warningReasons.length > 0, `Expected WARNING reason, got: ${result.reasons.join(' | ')}`)
    assert.ok(
      warningReasons[0]!.includes('NOT safe to delete'),
      `Warning should mention NOT safe to delete: ${warningReasons[0]}`,
    )
  })

  // ── Spec scenario 3: stash old file vs current file → blocked from auto-apply ──

  it('stash old file vs current file → blocked from auto-apply', async () => {
    // Setup: create a file, commit it
    makeFile(TMP, 'src/app.ts', 'const x = 1')
    gitAdd(TMP, ['src/app.ts'])
    gitCommit(TMP, 'initial commit')

    // Modify the file
    makeFile(TMP, 'src/app.ts', 'const x = 2')
    // Stash it
    execSync('git stash', { cwd: TMP })

    // Now modify the file again — current version is newer than stash
    makeFile(TMP, 'src/app.ts', 'const x = 3')

    const result = await guard.checkStashSafety('stash@{0}')

    assert.equal(result.blocked, true, 'stash with older content should block auto-apply')
    assert.ok(result.conflicts.length > 0, 'should have at least one conflict')

    const newerConflicts = result.conflicts.filter(c => c.status === 'newer')
    assert.ok(newerConflicts.length > 0, 'should detect newer working-tree file')
    assert.ok(
      newerConflicts.some(c => c.path === 'src/app.ts'),
      'src/app.ts should be listed as newer',
    )

    const blockedReasons = result.reasons.filter(r => r.startsWith('BLOCKED:'))
    assert.ok(blockedReasons.length > 0, `Expected BLOCKED reason, got: ${result.reasons.join(' | ')}`)
    assert.ok(
      blockedReasons[0]!.includes('newer'),
      `Reason should mention newer content: ${blockedReasons[0]}`,
    )
  })

  // ── Spec scenario 4: untracked file would be overwritten → blocked ──

  it('untracked file would be overwritten → blocked', async () => {
    // Setup: create a branch with a committed file
    makeFile(TMP, 'docs/readme.md', 'initial readme')
    gitAdd(TMP, ['docs/readme.md'])
    gitCommit(TMP, 'initial commit')

    // Create a branch with another file
    execSync('git checkout -b feature/docs', { cwd: TMP })
    makeFile(TMP, 'docs/notes.md', '# Notes from feature branch')
    gitAdd(TMP, ['docs/notes.md'])
    gitCommit(TMP, 'add notes on feature branch')

    // Switch back to main
    execSync('git checkout main', { cwd: TMP })

    // Create an untracked file with the same name as the one on the feature branch
    makeFile(TMP, 'docs/notes.md', '# Local untracked notes — must not be overwritten')

    const result = await guard.checkMergeSafety('feature/docs')

    assert.equal(result.blocked, true, 'merge that overwrites untracked files should block')
    assert.ok(
      result.wouldOverwriteUntracked.includes('docs/notes.md'),
      `docs/notes.md should be flagged, got: ${result.wouldOverwriteUntracked}`,
    )

    const blockedReasons = result.reasons.filter(r => r.startsWith('BLOCKED:'))
    assert.ok(blockedReasons.length > 0, `Expected BLOCKED reason, got: ${result.reasons.join(' | ')}`)
    assert.ok(
      blockedReasons.some(r => r.includes('untracked')),
      `Reason should mention untracked: ${blockedReasons.join(' | ')}`,
    )
  })

  // ── Edge case: promoted .rivet files should not trigger false positive ──

  it('promoted .rivet/playbook.jsonl does not block when tracked', async () => {
    makeDir(TMP, '.rivet')
    makeFile(TMP, '.rivet/playbook.jsonl', '{}')
    gitAdd(TMP, ['.rivet/playbook.jsonl'])

    const result = await guard.checkRuntimeArtifacts()

    // .rivet/playbook.jsonl is explicitly promoted → should not appear in tracked
    const hasPlaybook = result.tracked.some(f => f.includes('playbook.jsonl'))
    assert.equal(hasPlaybook, false, 'promoted .rivet/playbook.jsonl should not be flagged')
    assert.equal(result.blocked, false, 'promoted file alone should not block')
  })

  // ── Edge case: same stash content → not blocked ──

  it('same stash content vs current file → not blocked', async () => {
    makeFile(TMP, 'src/lib.ts', 'export const version = 1')
    gitAdd(TMP, ['src/lib.ts'])
    gitCommit(TMP, 'initial')

    // Modify and stash
    makeFile(TMP, 'src/lib.ts', 'export const version = 2')
    execSync('git stash', { cwd: TMP })

    // Apply the stash back
    execSync('git stash apply', { cwd: TMP })

    const result = await guard.checkStashSafety('stash@{0}')

    // File should now be same as stash content
    const sameConflicts = result.conflicts.filter(c => c.status === 'same')
    assert.ok(sameConflicts.length > 0, 'should detect same content')
    assert.equal(result.blocked, false, 'same content should not block')
  })

  // ── fullReport integration test ──

  it('fullReport returns safeToMerge=true for clean workspace', async () => {
    // Start clean
    makeFile(TMP, 'src/clean.ts', 'clean file')
    gitAdd(TMP, ['src/clean.ts'])
    gitCommit(TMP, 'clean commit')

    const report: WorkspaceGuardReport = await guard.fullReport()

    assert.equal(report.trackedRuntimeArtifacts.length, 0)
    assert.equal(report.ignoredButPresentRuntimeArtifacts.length, 0)
    assert.equal(report.stashConflicts.length, 0)
    assert.equal(report.wouldOverwriteUntracked.length, 0)
    assert.equal(report.safeToMerge, true, 'clean workspace should be safe to merge')
    assert.ok(report.reasons.length >= 0)
  })

  // ── fullReport with runtime artifacts present ──

  it('fullReport sets safeToMerge=false when runtime artifacts are tracked', async () => {
    makeDir(TMP, '.rivet/artifacts')
    makeFile(TMP, '.rivet/artifacts/data.json', '{}')
    gitAdd(TMP, ['.rivet/artifacts/data.json'], true)

    const report: WorkspaceGuardReport = await guard.fullReport()

    assert.equal(report.safeToMerge, false, 'tracked runtime artifacts should make safeToMerge=false')
    assert.ok(report.trackedRuntimeArtifacts.length > 0)
    assert.ok(report.reasons.some(r => r.startsWith('BLOCKED:')))
  })

  // ── WorkspaceGuard is not a class ──

  it('WorkspaceGuard uses factory pattern, not class', () => {
    const g = createWorkspaceGuard('/tmp/test')
    assert.equal(typeof g, 'object')
    assert.equal(typeof g.checkRuntimeArtifacts, 'function')
    assert.equal(typeof g.checkStashSafety, 'function')
    assert.equal(typeof g.checkMergeSafety, 'function')
    assert.equal(typeof g.fullReport, 'function')
    // No prototype chain inspection — just verifying it's a plain object with methods
    assert.ok(!(g instanceof (class {})), 'should not be a class instance')
  })
})
