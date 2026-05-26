import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { execSync } from 'node:child_process'
import { runHandsSession, type HandsSessionConfig } from '../hands-session.js'
import { WorktreeCoordinator } from '../worktree-coordinator.js'
import { createWriteWorkOrder, parseWorkerResult, type WorkOrder } from '../work-order.js'

function initGitRepo(dir: string, branch = 'main'): void {
  execSync(`git init -b ${branch}`, { cwd: dir, stdio: 'pipe' })
  execSync('git config user.email "test@test"', { cwd: dir, stdio: 'pipe' })
  execSync('git config user.name "Test"', { cwd: dir, stdio: 'pipe' })
  writeFileSync(join(dir, 'README.md'), '# test\n')
  execSync('git add -A && git commit -m "init"', { cwd: dir, stdio: 'pipe' })
}

/** Build a minimal write work order for testing. */
function testOrder(overrides: Partial<WorkOrder> = {}): WorkOrder {
  return createWriteWorkOrder({
    parentTurnId: 'turn-1',
    kind: 'patch_proposal',
    profile: 'patcher',
    objective: 'Write a test file',
    scope: { files: ['src/output.ts'] },
    ...overrides,
  })
}

describe('runHandsSession', () => {
  let baseDir: string
  let wtCoordinator: WorktreeCoordinator

  before(() => {
    baseDir = mkdtempSync(join(tmpdir(), 'rivet-hands-base-'))
    initGitRepo(baseDir)
    wtCoordinator = new WorktreeCoordinator(baseDir)
  })

  after(() => {
    wtCoordinator.cleanupAll()
    rmSync(baseDir, { recursive: true, force: true })
  })

  it('creates worktree, runs worker, collects diff artifact on completion', async () => {
    const order = testOrder()
    const config: HandsSessionConfig = {
      order,
      wtCoordinator,
      cwd: baseDir,
      maxTurns: 2,
      contextWindow: 128_000,
      compact: { enabled: false, autoThreshold: 800_000, autoFloor: 500_000, model: 'flash' },
      runAgent: async (prompt, _callbacks, workerCwd) => {
        assert.equal(order.workerCwd, workerCwd)
        assert.ok(prompt.includes(`CWD: ${workerCwd}`), prompt)
        // Simulate worker writing a file in the worktree it was asked to use
        assert.notEqual(workerCwd, baseDir)
        mkdirSync(join(workerCwd, 'src'), { recursive: true })
        writeFileSync(join(workerCwd, 'src', 'output.ts'), 'export const hello = 1\n')
        execSync('git add -A && git commit -m "worker output"', {
          cwd: workerCwd, stdio: 'pipe',
        })
        return JSON.stringify({
          workOrderId: order.id,
          status: 'passed',
          summary: 'Created src/output.ts',
          findings: [{ claim: 'Created output file', evidence: 'src/output.ts written', confidence: 'high' }],
          artifacts: [],
          changedFiles: ['src/output.ts'],
          risks: [],
          nextActions: [],
          evidenceStatus: 'verified',
        })
      },
    }

    const run = await runHandsSession(config)
    assert.equal(run.result.status, 'passed')
    assert.ok(run.result.changedFiles.includes('src/output.ts'), `changedFiles should include output.ts, got: ${run.result.changedFiles}`)

    // Should have collected a diff artifact
    const diffArtifact = run.result.artifacts.find(a => a.kind === 'diff')
    assert.ok(diffArtifact, `must include a diff artifact, artifacts: ${JSON.stringify(run.result.artifacts.map(a => a.kind))}`)
    assert.ok(diffArtifact!.content.includes('output.ts'), `diff should mention output.ts: ${diffArtifact!.content.slice(0, 300)}`)

    // Worktree should be cleaned up
    assert.equal(wtCoordinator.getActiveCount(), 0)
  })

  it('diffs worker changes against the current feature branch when baseRef is not provided', async () => {
    const featureBaseDir = mkdtempSync(join(tmpdir(), 'rivet-hands-feature-base-'))
    initGitRepo(featureBaseDir, 'feature/base')
    const featureCoordinator = new WorktreeCoordinator(featureBaseDir)
    try {
      const order = testOrder({ id: 'wo-feature-base' })
      const config: HandsSessionConfig = {
        order,
        wtCoordinator: featureCoordinator,
        cwd: featureBaseDir,
        maxTurns: 2,
        contextWindow: 128_000,
        compact: { enabled: false, autoThreshold: 800_000, autoFloor: 500_000, model: 'flash' },
        runAgent: async (_prompt, _callbacks, workerCwd) => {
          mkdirSync(join(workerCwd, 'src'), { recursive: true })
          writeFileSync(join(workerCwd, 'src', 'output.ts'), 'export const fromFeature = true\n')
          execSync('git add -A && git commit -m "worker output"', { cwd: workerCwd, stdio: 'pipe' })
          return JSON.stringify({
            workOrderId: order.id,
            status: 'passed',
            summary: 'Created src/output.ts',
            findings: [],
            artifacts: [],
            changedFiles: ['src/output.ts'],
            risks: [],
            nextActions: [],
            evidenceStatus: 'verified',
          })
        },
      }

      const run = await runHandsSession(config)
      const diffArtifact = run.result.artifacts.find(a => a.kind === 'diff')
      assert.ok(diffArtifact, 'must collect diff against feature/base instead of hard-coded main')
      assert.ok(diffArtifact!.content.includes('fromFeature'), diffArtifact!.content)
    } finally {
      featureCoordinator.cleanupAll()
      rmSync(featureBaseDir, { recursive: true, force: true })
    }
  })

  it('cleans up worktree even on worker failure', async () => {
    const order = testOrder({ id: 'wo-fail' })
    const config: HandsSessionConfig = {
      order,
      wtCoordinator,
      cwd: baseDir,
      maxTurns: 1,
      contextWindow: 128_000,
      compact: { enabled: false, autoThreshold: 800_000, autoFloor: 500_000, model: 'flash' },
      runAgent: async () => {
        throw new Error('Worker crashed')
      },
    }

    await assert.rejects(
      () => runHandsSession(config),
      /Worker crashed/,
    )
    // Worktree must still be cleaned up
    assert.equal(wtCoordinator.getActiveCount(), 0, 'worktree must be cleaned up even on failure')
  })

  it('handles worker returning blocked status (schema repair failure)', async () => {
    const order = testOrder({ id: 'wo-blocked' })
    const config: HandsSessionConfig = {
      order,
      wtCoordinator,
      cwd: baseDir,
      maxTurns: 1,
      contextWindow: 128_000,
      compact: { enabled: false, autoThreshold: 800_000, autoFloor: 500_000, model: 'flash' },
      runAgent: async () => {
        return 'not valid json {{{'
      },
    }

    const run = await runHandsSession(config)
    // Should be blocked due to unparseable result
    assert.equal(run.result.status, 'blocked')
    assert.equal(wtCoordinator.getActiveCount(), 0)
  })
})
