import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { execSync } from 'child_process'
import { existsSync, mkdirSync, writeFileSync, rmSync, readFileSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import {
  createCheckpoint,
  getRollbackPreview,
  rollbackToCheckpoint,
  listCheckpoints,
  recordAgentTouchedFile,
} from '../checkpoint.js'

function makeTempGitRepo(): string {
  const repo = join(tmpdir(), `rivet-ck-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`)
  mkdirSync(repo, { recursive: true })
  execSync('git init', { cwd: repo })
  execSync('git config user.email "test@test.com"', { cwd: repo })
  execSync('git config user.name "Test"', { cwd: repo })
  writeFileSync(join(repo, 'initial.txt'), 'hello')
  execSync('git add .', { cwd: repo })
  execSync('git commit -m "initial"', { cwd: repo })
  return repo
}

function cleanupRepo(repo: string): void {
  if (existsSync(repo)) rmSync(repo, { recursive: true, force: true })
}

describe('checkpoint module', () => {
  describe('createCheckpoint', () => {
    it('returns a valid Checkpoint with hash and timestamp in a git repo', async () => {
      const repo = makeTempGitRepo()
      try {
        const before = Date.now()
        const cp = await createCheckpoint(repo, 'auto')
        const after = Date.now()

        assert.ok(cp)
        assert.match(cp.hash, /^[0-9a-f]{40}$/)
        assert.equal(cp.message, 'auto')
        assert.ok(cp.timestamp >= before && cp.timestamp <= after)
      } finally {
        cleanupRepo(repo)
      }
    })

    it('returns null in a non-git directory', async () => {
      const nonGitDir = join(tmpdir(), `rivet-nogit-${Date.now()}`)
      mkdirSync(nonGitDir, { recursive: true })
      try {
        const cp = await createCheckpoint(nonGitDir, 'auto')
        assert.equal(cp, null)
      } finally {
        cleanupRepo(nonGitDir)
      }
    })

    it('defaults label to "checkpoint"', async () => {
      const repo = makeTempGitRepo()
      try {
        const cp = await createCheckpoint(repo)
        assert.ok(cp)
        assert.equal(cp.message, 'checkpoint')
      } finally {
        cleanupRepo(repo)
      }
    })
  })

  describe('getRollbackPreview', () => {
    it('returns null when no checkpoint exists', async () => {
      const repo = makeTempGitRepo()
      try {
        const preview = await getRollbackPreview(repo)
        assert.equal(preview, null)
      } finally {
        cleanupRepo(repo)
      }
    })

    it('returns null when no agent-owned changes', async () => {
      const repo = makeTempGitRepo()
      try {
        await createCheckpoint(repo, 'auto')
        const preview = await getRollbackPreview(repo)
        assert.equal(preview, null)
      } finally {
        cleanupRepo(repo)
      }
    })

    it('returns preview with confirmation token for agent files', async () => {
      const repo = makeTempGitRepo()
      try {
        await createCheckpoint(repo, 'auto')
        recordAgentTouchedFile(repo, 'agent-created.txt')
        writeFileSync(join(repo, 'agent-created.txt'), 'agent work')

        const preview = await getRollbackPreview(repo)
        assert.ok(preview)
        assert.ok(preview.confirmationToken)
        assert.ok(preview.text.includes('agent-created.txt'))
      } finally {
        cleanupRepo(repo)
      }
    })
  })

  describe('rollbackToCheckpoint', () => {
    it('returns { success: false } when no checkpoint exists', async () => {
      const repo = makeTempGitRepo()
      try {
        const result = await rollbackToCheckpoint(repo)
        assert.equal(result.success, false)
      } finally {
        cleanupRepo(repo)
      }
    })

    it('requires confirmation token for rollback', async () => {
      const repo = makeTempGitRepo()
      try {
        await createCheckpoint(repo, 'auto')
        recordAgentTouchedFile(repo, 'agent-created.txt')
        writeFileSync(join(repo, 'agent-created.txt'), 'agent work')
        const result = await rollbackToCheckpoint(repo)
        assert.equal(result.success, false)
      } finally {
        cleanupRepo(repo)
      }
    })

    it('does not remove pre-existing unstaged changes during rollback', async () => {
      const repo = makeTempGitRepo()
      try {
        writeFileSync(join(repo, 'user-work.txt'), 'user work before agent')
        const cp = await createCheckpoint(repo, 'auto')
        assert.ok(cp)

        recordAgentTouchedFile(repo, 'agent-created.txt')
        writeFileSync(join(repo, 'agent-created.txt'), 'agent work')

        const preview = await getRollbackPreview(repo)
        assert.ok(preview)
        const result = await rollbackToCheckpoint(repo, preview.confirmationToken)

        assert.equal(result.success, true)
        assert.ok(existsSync(join(repo, 'user-work.txt')))
        assert.ok(!existsSync(join(repo, 'agent-created.txt')))
      } finally {
        cleanupRepo(repo)
      }
    })

    it('restores tracked files to checkpoint state', async () => {
      const repo = makeTempGitRepo()
      try {
        writeFileSync(join(repo, 'tracked.txt'), 'original')
        execSync('git add tracked.txt', { cwd: repo })
        execSync('git commit -m "add tracked"', { cwd: repo })

        const cp = await createCheckpoint(repo, 'auto')
        assert.ok(cp)

        recordAgentTouchedFile(repo, 'tracked.txt')
        writeFileSync(join(repo, 'tracked.txt'), 'modified by agent')

        const preview = await getRollbackPreview(repo)
        assert.ok(preview)
        const result = await rollbackToCheckpoint(repo, preview.confirmationToken)

        assert.equal(result.success, true)
        assert.equal(readFileSync(join(repo, 'tracked.txt'), 'utf-8'), 'original')
      } finally {
        cleanupRepo(repo)
      }
    })

    it('rejects wrong confirmation token', async () => {
      const repo = makeTempGitRepo()
      try {
        await createCheckpoint(repo, 'auto')
        recordAgentTouchedFile(repo, 'agent-file.txt')
        writeFileSync(join(repo, 'agent-file.txt'), 'data')

        const result = await rollbackToCheckpoint(repo, 'wrong-token')
        assert.equal(result.success, false)
      } finally {
        cleanupRepo(repo)
      }
    })
  })

  describe('listCheckpoints', () => {
    it('returns empty array when no checkpoint exists', () => {
      const repo = makeTempGitRepo()
      try {
        assert.deepEqual(listCheckpoints(repo), [])
      } finally {
        cleanupRepo(repo)
      }
    })

    it('returns single checkpoint after createCheckpoint', async () => {
      const repo = makeTempGitRepo()
      try {
        await createCheckpoint(repo, 'manual')
        const list = listCheckpoints(repo)
        assert.equal(list.length, 1)
        assert.equal(list[0]!.message, 'manual')
        assert.match(list[0]!.hash, /^[0-9a-f]{7}$/)
        assert.ok(list[0]!.timestamp > 0)
      } finally {
        cleanupRepo(repo)
      }
    })
  })
})
