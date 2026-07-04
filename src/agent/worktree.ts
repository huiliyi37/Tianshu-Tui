import { spawnSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { tmpdir } from 'node:os'

export interface WorktreeEntry {
  path: string
  commit: string
  branch: string
}

export interface CreatedWorktree {
  path: string
  branch: string
}

// git worktree list --porcelain output is stable and supports spaces in paths.
export function parseWorktreeList(output: string): WorktreeEntry[] {
  const entries: WorktreeEntry[] = []
  let current: Partial<WorktreeEntry> = {}
  let sawPorcelain = false

  for (const line of output.split('\n')) {
    if (!line.trim()) {
      if (current.path && current.commit && current.branch) {
        entries.push({ path: current.path, commit: current.commit, branch: current.branch })
      }
      current = {}
      continue
    }
    if (line.startsWith('worktree ')) {
      sawPorcelain = true
      current.path = line.slice('worktree '.length)
    }
    if (line.startsWith('HEAD ')) {
      sawPorcelain = true
      current.commit = line.slice('HEAD '.length)
    }
    if (line.startsWith('branch ')) {
      sawPorcelain = true
      current.branch = line.slice('branch '.length).replace(/^refs\/heads\//, '')
    }
    if (line === 'detached') {
      sawPorcelain = true
      current.branch = '(detached)'
    }
  }

  if (current.path && current.commit && current.branch) {
    entries.push({ path: current.path, commit: current.commit, branch: current.branch })
  }

  if (sawPorcelain) return entries

  // Backward-compatible parser for the default human format:
  // "<path>  <commit> [<branch>]". Kept for tests and callers with captured output.
  const humanRe = /^(.*?)\s+([0-9a-fA-F]+)\s+\[(.+?)\]$/
  return output
    .trim()
    .split('\n')
    .filter(Boolean)
    .map(line => {
      const match = humanRe.exec(line)
      if (!match) return null
      const [, path, commit, branch] = match
      if (!path || !commit || !branch) return null
      return { path, commit, branch }
    })
    .filter((entry): entry is WorktreeEntry => entry !== null)
}

export function buildWorktreeArgs(path: string, branch?: string): string[] {
  return branch ? ['worktree', 'add', '-b', branch, path] : ['worktree', 'add', '--detach', path]
}

/**
 * Args for a detached worktree pinned to a specific commit-ish at an explicit
 * path. Unlike buildWorktreeArgs, this lets VSW check out baseline.head (not the
 * current HEAD) into a caller-controlled directory (e.g. .rivet/vsw/<sessionId>).
 */
export function buildDetachedWorktreeArgs(path: string, commitish: string): string[] {
  return ['worktree', 'add', '--detach', path, commitish]
}

const OWNER_FILE = '.vsw-owner.json'

function writeOwnerMarker(path: string, sessionId: string): void {
  try {
    writeFileSync(join(path, OWNER_FILE), JSON.stringify({ pid: process.pid, sessionId }), 'utf-8')
  } catch { /* best-effort */ }
}

function git(cwd: string, args: string[]): { ok: boolean; stdout: string; stderr: string } {
  const result = spawnSync('git', args, {
    cwd,
    encoding: 'utf-8',
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  return {
    ok: result.status === 0,
    stdout: typeof result.stdout === 'string' ? result.stdout : '',
    stderr: typeof result.stderr === 'string' ? result.stderr : '',
  }
}

function branchExists(cwd: string, branch: string): boolean {
  return git(cwd, ['show-ref', '--verify', '--quiet', `refs/heads/${branch}`]).ok
}

function uniqueBranch(cwd: string, baseBranch: string): string {
  if (!branchExists(cwd, baseBranch)) return baseBranch
  // Append a random suffix to avoid collisions with stale branches left by
  // previous crashed runs. The random part keeps concurrent workers unlikely
  // to pick the same name even if they race.
  for (let attempt = 1; attempt <= 20; attempt++) {
    const suffix = Math.random().toString(36).slice(2, 8)
    const candidate = `${baseBranch}-${suffix}`
    if (!branchExists(cwd, candidate)) return candidate
  }
  return `${baseBranch}-${Date.now()}`
}

export function createWorktree(cwd: string, sessionId: string, branch = `rivet-hands-${sessionId.slice(0, 8)}`): CreatedWorktree {
  const safeSessionId = sessionId.replace(/[^a-zA-Z0-9_-]/g, '-')
  branch = uniqueBranch(cwd, branch)
  let lastError = ''
  for (let attempt = 0; attempt < 3; attempt++) {
    const wtPath = mkdtempSync(join(tmpdir(), `rivet-wt-${safeSessionId.slice(0, 8)}-${attempt}-`))
    const result = git(cwd, buildWorktreeArgs(wtPath, branch))
    if (result.ok) {
      writeOwnerMarker(wtPath, sessionId)
      return { path: wtPath, branch }
    }
    lastError = result.stderr || result.stdout || '(git produced no output)'
    try { rmSync(wtPath, { recursive: true, force: true }) } catch {}
    // If the branch somehow appeared mid-flight, pick a fresh unique one.
    if (branchExists(cwd, branch)) {
      branch = uniqueBranch(cwd, `rivet-hands-${safeSessionId.slice(0, 8)}`)
    }
  }
  throw new Error(`failed to create git worktree for ${sessionId}: ${lastError}`)
}

/**
 * Create a detached worktree at `wtPath` checked out to `commitish`.
 * The parent directory of wtPath is created if needed. Throws on git failure.
 * Used by VSW to materialize an isolated tree at baseline.head.
 */
export function createWorktreeAt(cwd: string, wtPath: string, commitish: string): CreatedWorktree {
  mkdirSync(dirname(wtPath), { recursive: true })
  const result = git(cwd, buildDetachedWorktreeArgs(wtPath, commitish))
  if (!result.ok) {
    try { rmSync(wtPath, { recursive: true, force: true }) } catch {}
    throw new Error(`failed to create detached git worktree at ${wtPath} for ${commitish}`)
  }
  return { path: wtPath, branch: '(detached)' }
}

export function removeWorktree(cwd: string, wtPath: string, branch?: string, opts?: { keepBranch?: boolean }): void {
  git(cwd, ['worktree', 'remove', '--force', wtPath])
  if (branch && !opts?.keepBranch) git(cwd, ['branch', '-D', branch])
  // Clean up owner marker so the reaper doesn't try to reap an already-removed worktree
  try { rmSync(join(wtPath, OWNER_FILE), { force: true }) } catch {}
}

export interface CommitAllResult {
  ok: boolean
  /** Commit sha on success; undefined when nothing to commit or on failure. */
  sha?: string
  /** True when the tree was already clean (ok=true, no commit created). */
  nothingToCommit?: boolean
  error?: string
}

/**
 * Stage everything and commit in the given directory. Used for archive
 * checkpoints and the desktop "Commit" landing action. Returns a structured
 * result instead of throwing — callers decide how fatal a failure is.
 */
/** Working-tree dirtiness, ignoring the vsw owner marker (infrastructure noise). */
function isDirty(cwd: string): boolean {
  const status = git(cwd, ['status', '--porcelain', '-uall'])
  if (!status.ok) return false
  return status.stdout.split('\n').some(line => {
    const trimmed = line.trim()
    return trimmed.length > 0 && !trimmed.endsWith(OWNER_FILE)
  })
}

export function commitAll(cwd: string, message: string, opts?: { noVerify?: boolean }): CommitAllResult {
  if (!isDirty(cwd)) return { ok: true, nothingToCommit: true }
  const add = git(cwd, ['add', '-A', '--', '.', `:(exclude)${OWNER_FILE}`])
  if (!add.ok) return { ok: false, error: add.stderr || add.stdout || 'git add failed' }
  const args = ['commit', '-m', message]
  if (opts?.noVerify) args.push('--no-verify')
  const commit = git(cwd, args)
  if (!commit.ok) return { ok: false, error: commit.stderr || commit.stdout || 'git commit failed' }
  const sha = git(cwd, ['rev-parse', 'HEAD'])
  return { ok: true, sha: sha.ok ? sha.stdout.trim() : undefined }
}

export interface UnlandedWork {
  /** Uncommitted changes (staged/unstaged/untracked) exist in the worktree. */
  dirty: boolean
  /** Commits on the worktree branch not reachable from the main workspace HEAD. */
  unmergedCommits: number
}

/**
 * Detect work in a session worktree that would be lost if the worktree and its
 * branch were removed: uncommitted changes in the tree, or commits on the
 * branch that the main workspace HEAD doesn't contain. Fail-open on git
 * errors (report work present) so archive never silently destroys data.
 */
export function hasUnlandedWork(cwd: string, wtPath: string, branch?: string): UnlandedWork {
  // If status fails (worktree dir gone / not a repo) there is nothing to lose.
  // The .vsw-owner.json marker is infrastructure noise, not user work.
  const dirty = isDirty(wtPath)

  let unmergedCommits = 0
  if (branch && branchExists(cwd, branch)) {
    const revList = git(cwd, ['rev-list', '--count', `HEAD..${branch}`])
    if (revList.ok) {
      unmergedCommits = Number.parseInt(revList.stdout.trim(), 10) || 0
    } else {
      // Can't tell — fail-open: assume the branch has unmerged work.
      unmergedCommits = 1
    }
  }
  return { dirty, unmergedCommits }
}

/**
 * Remove stale `rivet-hands-*` branches that are not associated with any
 * registered worktree. These are typically left behind when a previous run
 * crashed between worktree creation and branch deletion. Returns the list of
 * removed branch names (best-effort).
 *
 * Branches with commits not reachable from HEAD are preserved — they hold
 * unlanded work (archive keeps such branches deliberately; crashed sessions
 * may too). Only branches with zero unique commits are deleted.
 */
export function cleanupStaleHandsBranches(cwd: string): string[] {
  const removed: string[] = []
  const wtResult = git(cwd, ['worktree', 'list', '--porcelain'])
  if (!wtResult.ok) return removed

  const activeBranches = new Set(
    parseWorktreeList(wtResult.stdout)
      .map(e => e.branch)
      .filter((b): b is string => !!b && b.startsWith('rivet-hands-')),
  )

  const branchResult = git(cwd, ['branch', '--list', 'rivet-hands-*'])
  if (!branchResult.ok) return removed

  for (const raw of branchResult.stdout.split('\n')) {
    const branch = raw.replace(/^\*\s*/, '').trim()
    if (!branch.startsWith('rivet-hands-')) continue
    if (activeBranches.has(branch)) continue
    // Keep branches that carry unmerged commits — deleting them loses work.
    const revList = git(cwd, ['rev-list', '--count', `HEAD..${branch}`])
    const unmerged = revList.ok ? Number.parseInt(revList.stdout.trim(), 10) || 0 : 1
    if (unmerged > 0) continue
    const del = git(cwd, ['branch', '-D', branch])
    if (del.ok) removed.push(branch)
  }
  return removed
}

export interface SquashMergeResult {
  ok: boolean
  /** Squash commit sha on success. */
  sha?: string
  /** True when the branch had no changes relative to the target HEAD. */
  nothingToMerge?: boolean
  /** Conflicted file paths when the merge failed on conflicts. */
  conflictFiles?: string[]
  error?: string
}

/**
 * Squash-merge `branch` into the current branch of `cwd` (the main workspace)
 * and commit. Fail-closed: refuses when the target tree is dirty, and rolls
 * back (`git reset --merge`) on conflict, reporting the conflicted files.
 */
export function squashMergeBranch(cwd: string, branch: string, message: string): SquashMergeResult {
  if (!branchExists(cwd, branch)) return { ok: false, error: `branch not found: ${branch}` }
  if (isDirty(cwd)) {
    return { ok: false, error: 'main workspace has uncommitted changes — commit or stash them before merging back' }
  }
  const merge = git(cwd, ['merge', '--squash', branch])
  if (!merge.ok) {
    const conflicts = git(cwd, ['diff', '--name-only', '--diff-filter=U'])
    const conflictFiles = conflicts.ok
      ? conflicts.stdout.split('\n').map(l => l.trim()).filter(Boolean)
      : []
    // Squash merges don't create MERGE_HEAD, so `merge --abort` may not apply —
    // reset --merge restores the pre-merge index and working tree.
    git(cwd, ['merge', '--abort'])
    git(cwd, ['reset', '--merge'])
    return {
      ok: false,
      conflictFiles,
      error: conflictFiles.length > 0
        ? `merge conflicts in ${conflictFiles.length} file(s)`
        : (merge.stderr || merge.stdout || 'git merge --squash failed'),
    }
  }
  const commit = git(cwd, ['commit', '-m', message])
  if (!commit.ok) {
    const output = `${commit.stdout}\n${commit.stderr}`
    if (/nothing to commit|nothing added to commit/i.test(output)) {
      return { ok: true, nothingToMerge: true }
    }
    // Commit failed (e.g. hook rejection) — unstage the squashed changes.
    git(cwd, ['reset', '--merge'])
    return { ok: false, error: commit.stderr || commit.stdout || 'git commit failed' }
  }
  const sha = git(cwd, ['rev-parse', 'HEAD'])
  return { ok: true, sha: sha.ok ? sha.stdout.trim() : undefined }
}

/**
 * Push `branch` to origin with upstream tracking. Never prompts for
 * credentials (GIT_TERMINAL_PROMPT=0) and times out instead of hanging.
 */
export function pushBranch(cwd: string, branch: string): { ok: boolean; error?: string } {
  const result = spawnSync('git', ['push', '-u', 'origin', branch], {
    cwd,
    encoding: 'utf-8',
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: 60_000,
    env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
  })
  if (result.status === 0) return { ok: true }
  const stderr = typeof result.stderr === 'string' ? result.stderr : ''
  const stdout = typeof result.stdout === 'string' ? result.stdout : ''
  return { ok: false, error: (stderr || stdout || 'git push failed').trim() }
}

/** Current HEAD commit hash, or undefined outside a git repo. */
export function revParseHead(cwd: string): string | undefined {
  const result = git(cwd, ['rev-parse', 'HEAD'])
  const sha = result.stdout.trim()
  return result.ok && sha ? sha : undefined
}

export function getCurrentGitRef(cwd: string): string | undefined {
  const branch = git(cwd, ['rev-parse', '--abbrev-ref', 'HEAD'])
  const branchName = branch.stdout.trim()
  if (branch.ok && branchName && branchName !== 'HEAD') return branchName

  const commit = git(cwd, ['rev-parse', 'HEAD'])
  const commitHash = commit.stdout.trim()
  return commit.ok && commitHash ? commitHash : undefined
}

export function listWorktrees(cwd: string): WorktreeEntry[] {
  const output = git(cwd, ['worktree', 'list', '--porcelain'])
  return output.ok ? parseWorktreeList(output.stdout) : []
}
