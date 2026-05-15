import { describe, it, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { execSync } from 'child_process'
import { existsSync, mkdirSync, readFileSync, writeFileSync, rmSync, copyFileSync } from 'fs'
import { join } from 'path'
import { homedir, tmpdir } from 'os'
import {
  createCheckpoint,
  getRollbackPreview,
  rollbackToCheckpoint,
  listCheckpoints,
} from '../checkpoint.js'

const RIVET_DIR = join(homedir(), '.rivet')
const CHECKPOINT_FILE = join(RIVET_DIR, 'checkpoint.json')
const BACKUP_FILE = CHECKPOINT_FILE + '.test-backup'

/**
 * Create a temporary git repo with an initial commit.
 * Returns the repo path for use as cwd.
 */
function makeTempGitRepo(): string {
  const repo = join(tmpdir(), `rivet-checkpoint-test-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`)
  mkdirSync(repo, { recursive: true })
  execSync('git init', { cwd: repo })
  execSync('git config user.email "test@test.com"', { cwd: repo })
  execSync('git config user.name "Test"', { cwd: repo })
  writeFileSync(join(repo, 'initial.txt'), 'hello')
  execSync('git add .', { cwd: repo })
  execSync('git commit -m "initial"', { cwd: repo })
  return repo
}

/** Remove a temp repo directory. */
function cleanupRepo(repo: string): void {
  if (existsSync(repo)) {
    rmSync(repo, { recursive: true, force: true })
  }
}

describe('checkpoint module', () => {
  // Preserve/restore any existing checkpoint file to avoid polluting user state
  let hadExistingCheckpoint: boolean

  beforeEach(() => {
    hadExistingCheckpoint = existsSync(CHECKPOINT_FILE)
    if (hadExistingCheckpoint) {
      copyFileSync(CHECKPOINT_FILE, BACKUP_FILE)
      rmSync(CHECKPOINT_FILE, { force: true })
    }
  })

  afterEach(() => {
    if (hadExistingCheckpoint) {
      copyFileSync(BACKUP_FILE, CHECKPOINT_FILE)
      rmSync(BACKUP_FILE, { force: true })
    } else {
      rmSync(CHECKPOINT_FILE, { force: true })
    }
  })

  describe('createCheckpoint', () => {
    it('returns a valid Checkpoint with hash and timestamp in a git repo', async () => {
      const repo = makeTempGitRepo()
      try {
        const before = Date.now()
        const cp = await createCheckpoint(repo, 'auto')
        const after = Date.now()

        assert.ok(cp, 'createCheckpoint should return a non-null Checkpoint')
        assert.match(cp.hash, /^[0-9a-f]{40}$/, 'hash should be a 40-char hex SHA')
        assert.equal(cp.message, 'auto')
        assert.ok(cp.timestamp >= before && cp.timestamp <= after, 'timestamp should be within test window')

        // Verify checkpoint file was written
        assert.ok(existsSync(CHECKPOINT_FILE), 'checkpoint file should exist on disk')
        const stored = JSON.parse(readFileSync(CHECKPOINT_FILE, 'utf-8'))
        assert.equal(stored.hash, cp.hash)
        assert.equal(stored.label, 'auto')
        assert.equal(stored.cwd, repo)
      } finally {
        cleanupRepo(repo)
      }
    })

    it('returns null in a non-git directory (graceful failure)', async () => {
      const nonGitDir = join(tmpdir(), `rivet-no-git-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`)
      mkdirSync(nonGitDir, { recursive: true })
      try {
        const cp = await createCheckpoint(nonGitDir, 'auto')
        assert.equal(cp, null, 'createCheckpoint should return null in a non-git directory')
      } finally {
        cleanupRepo(nonGitDir)
      }
    })

    it('defaults label to "checkpoint" when no label is provided', async () => {
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
      // No checkpoint file created — preview should be null
      const repo = makeTempGitRepo()
      try {
        const preview = await getRollbackPreview(repo)
        assert.equal(preview, null, 'getRollbackPreview should return null with no checkpoint file')
      } finally {
        cleanupRepo(repo)
      }
    })

    it('returns null when no changes since checkpoint', async () => {
      const repo = makeTempGitRepo()
      try {
        await createCheckpoint(repo, 'auto')

        // No changes made after checkpoint — preview should be null
        const preview = await getRollbackPreview(repo)
        assert.equal(preview, null, 'getRollbackPreview should return null when repo is unchanged')
      } finally {
        cleanupRepo(repo)
      }
    })

    it('returns preview text when there are changes since checkpoint', async () => {
      const repo = makeTempGitRepo()
      try {
        await createCheckpoint(repo, 'auto')

        // Make a new commit after the checkpoint
        writeFileSync(join(repo, 'changed.txt'), 'new content')
        execSync('git add .', { cwd: repo })
        execSync('git commit -m "post-checkpoint change"', { cwd: repo })

        const preview = await getRollbackPreview(repo)
        assert.ok(preview, 'getRollbackPreview should return non-null when changes exist')
        assert.ok(preview.includes('Committed changes'), 'preview should mention committed changes')
        assert.ok(preview.includes('changed.txt'), 'preview should reference the changed file')
      } finally {
        cleanupRepo(repo)
      }
    })

    it('reports unstaged changes in preview', async () => {
      const repo = makeTempGitRepo()
      try {
        await createCheckpoint(repo, 'auto')

        // Create an unstaged modification
        writeFileSync(join(repo, 'initial.txt'), 'modified')

        const preview = await getRollbackPreview(repo)
        assert.ok(preview, 'getRollbackPreview should detect unstaged changes')
        assert.ok(preview.includes('Unstaged changes'), 'preview should mention unstaged changes')
      } finally {
        cleanupRepo(repo)
      }
    })

    it('reports untracked files in preview', async () => {
      const repo = makeTempGitRepo()
      try {
        await createCheckpoint(repo, 'auto')

        // Create an untracked file
        writeFileSync(join(repo, 'untracked.txt'), 'new file')

        const preview = await getRollbackPreview(repo)
        assert.ok(preview, 'getRollbackPreview should detect untracked files')
        assert.ok(preview.includes('Untracked files'), 'preview should mention untracked files')
        assert.ok(preview.includes('untracked.txt'), 'preview should list the untracked file')
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
        assert.equal(result.success, false, 'rollback should fail when no checkpoint file exists')
        assert.equal('hash' in result, false, 'should not include hash on failure')
      } finally {
        cleanupRepo(repo)
      }
    })

    it('rolls back to checkpoint and reports success', async () => {
      const repo = makeTempGitRepo()
      try {
        const cp = await createCheckpoint(repo, 'auto')
        assert.ok(cp)

        // Add a file and commit after the checkpoint
        writeFileSync(join(repo, 'post.txt'), 'should be removed')
        execSync('git add .', { cwd: repo })
        execSync('git commit -m "post-checkpoint"', { cwd: repo })

        const result = await rollbackToCheckpoint(repo)
        assert.equal(result.success, true, 'rollback should succeed')
        assert.equal(result.hash, cp!.hash.slice(0, 7), 'should return short hash')

        // Verify the post-checkpoint file is gone
        assert.ok(!existsSync(join(repo, 'post.txt')), 'post-checkpoint file should be removed after rollback')

        // Verify initial file is intact
        assert.ok(existsSync(join(repo, 'initial.txt')), 'initial file should survive rollback')
      } finally {
        cleanupRepo(repo)
      }
    })

    it('removes untracked files during rollback', async () => {
      const repo = makeTempGitRepo()
      try {
        await createCheckpoint(repo, 'auto')

        // Create an untracked file
        writeFileSync(join(repo, 'orphan.txt'), 'untracked')

        const result = await rollbackToCheckpoint(repo)
        assert.equal(result.success, true)
        assert.ok(!existsSync(join(repo, 'orphan.txt')), 'untracked file should be removed by git clean')
      } finally {
        cleanupRepo(repo)
      }
    })
  })

  describe('listCheckpoints', () => {
    it('returns empty array when no checkpoint exists', async () => {
      const repo = makeTempGitRepo()
      try {
        const list = listCheckpoints(repo)
        assert.deepEqual(list, [])
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
        assert.match(list[0]!.hash, /^[0-9a-f]{7}$/, 'list should return short hash')
        assert.ok(list[0]!.timestamp > 0)
      } finally {
        cleanupRepo(repo)
      }
    })
  })
})
