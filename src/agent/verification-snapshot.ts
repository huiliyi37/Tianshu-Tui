/**
 * Verification Snapshot Worktree (VSW) — P1 core
 *
 * Materializes an isolated git worktree at `baseline.head` + only the current
 * session's owned diff, so verification runs free of concurrent-session
 * pollution. The tree is built as:
 *
 *   git worktree add --detach <.rivet/vsw/sessionId> <baseline.head>
 *   overlay owned diff:
 *     - tracked owned (modify/delete): `git diff <baseline.head> -- <owned> | git apply`
 *       (git natively handles add/modify/delete; applied onto the baseline tree)
 *     - untracked owned (new files): materializeScope (copies only when target absent,
 *       so it composes after git apply without clobbering tracked overlays)
 *
 * Non-owned files stay at baseline.head — concurrent commits/dirt never leak in,
 * so a Phase-A failure attributes cleanly to owned changes (辅's no-ambiguity rule).
 *
 * Lifecycle reuses worktree.ts primitives (createWorktreeAt / removeWorktree).
 * The overlay itself is net-new logic — materializeScope alone cannot apply
 * tracked changes/deletions (it skips existing targets), so this module does not
 * pretend to be a zero-rewrite reuse.
 *
 * @module verification-snapshot
 */

import { spawnSync } from 'node:child_process'
import { existsSync, rmSync } from 'node:fs'
import { isAbsolute, join, relative } from 'node:path'
import { createWorktreeAt, removeWorktree } from './worktree.js'
import { materializeScope } from './worktree-scope.js'
import { RepoLock, worktreeRegistryLockPath } from './repo-lock.js'

export interface VerificationSnapshotInit {
  /** Main repository working directory (the live, shared worktree). */
  baseCwd: string
  /** Session identifier — also the leaf dir under .rivet/vsw/. */
  sessionId: string
  /** Real baseline commit-ish (BaselineSnapshot.head). */
  baselineHead: string
  /** Files owned by the current session (repo-relative or absolute-under-baseCwd). */
  ownedFiles: string[]
  /** Cross-session lock guarding .git/worktrees mutations. Injectable for tests;
   *  defaults to a RepoLock on .rivet/worktree-registry.lock under baseCwd. */
  lock?: RepoLock
}

export interface OverlayResult {
  /** True if a tracked owned diff was applied via git apply. */
  appliedDiff: boolean
  /** Untracked owned files copied in via materializeScope (repo-relative). */
  materialized: string[]
  /** Owned entries outside the repo or absent from both trees. */
  missing: string[]
}

export interface VerificationSnapshot {
  /** Absolute path to the snapshot worktree. */
  readonly path: string
  /** Baseline commit-ish this snapshot is pinned to. */
  readonly baselineHead: string
  /** Rebuild the tree at baseline.head + the given owned diff. */
  refresh(ownedFiles: string[]): OverlayResult
  /** Remove the worktree (git worktree remove) and scrub the directory. */
  destroy(): void
}

interface GitResult {
  status: number
  stdout: string
  stderr: string
}

function git(cwd: string, args: string[], input?: string): GitResult {
  const result = spawnSync('git', args, {
    cwd,
    encoding: 'utf-8',
    input,
    stdio: ['pipe', 'pipe', 'pipe'],
    maxBuffer: 64 * 1024 * 1024,
  })
  return {
    status: typeof result.status === 'number' ? result.status : 1,
    stdout: typeof result.stdout === 'string' ? result.stdout : '',
    stderr: typeof result.stderr === 'string' ? result.stderr : '',
  }
}

/** Where a session's snapshot worktree lives. .rivet/ is gitignored. */
export function snapshotPath(baseCwd: string, sessionId: string): string {
  return join(baseCwd, '.rivet', 'vsw', sessionId)
}

/** Normalize an owned path to a repo-relative path, or null if outside the repo. */
function toRepoRelative(baseCwd: string, filePath: string): string | null {
  if (!isAbsolute(filePath)) {
    return filePath.startsWith('..') ? null : filePath
  }
  const rel = relative(baseCwd, filePath)
  if (rel === '' || rel.startsWith('..')) return null
  return rel
}

function overlayOwnedDiff(
  baseCwd: string,
  worktreePath: string,
  baselineHead: string,
  ownedFiles: string[],
): OverlayResult {
  const rels: string[] = []
  const abs: string[] = []
  for (const f of ownedFiles) {
    const rel = toRepoRelative(baseCwd, f)
    if (!rel) continue
    rels.push(rel)
    abs.push(isAbsolute(f) ? f : join(baseCwd, f))
  }

  let appliedDiff = false
  if (rels.length > 0) {
    // Diff baseline.head against the live working tree for owned paths only.
    // Captures tracked modifications and deletions; untracked-new files do not
    // appear here (git diff ignores untracked) — they go through materializeScope.
    const diff = git(baseCwd, ['diff', '--no-color', baselineHead, '--', ...rels])
    const patch = diff.stdout
    if (patch.trim().length > 0) {
      const applied = git(worktreePath, ['apply', '--whitespace=nowarn'], patch)
      if (applied.status !== 0) {
        throw new Error(`VSW overlay: git apply failed in ${worktreePath}: ${applied.stderr.trim()}`)
      }
      appliedDiff = true
    }
  }

  // Untracked-new owned files: copied only when the target is absent, so this
  // never clobbers the tracked overlay git apply just wrote.
  const mat = materializeScope(baseCwd, worktreePath, abs)
  return { appliedDiff, materialized: mat.materialized, missing: mat.missing }
}

function destroyAt(baseCwd: string, worktreePath: string): void {
  try {
    removeWorktree(baseCwd, worktreePath)
  } catch {
    // best-effort — fall through to directory scrub
  }
  try {
    if (existsSync(worktreePath)) rmSync(worktreePath, { recursive: true, force: true })
  } catch {
    // best-effort
  }
}

/**
 * Build a verification snapshot. Any stale worktree at the same path is removed
 * first. Throws if git worktree creation or overlay fails (no fake green).
 */
export function createVerificationSnapshot(init: VerificationSnapshotInit): VerificationSnapshot {
  const path = snapshotPath(init.baseCwd, init.sessionId)
  const lock = init.lock ?? new RepoLock({ lockPath: worktreeRegistryLockPath(init.baseCwd) })

  function build(ownedFiles: string[]): OverlayResult {
    // Only the .git/worktrees registry mutations (remove + add) need cross-session
    // serialization; the per-session overlay writes into our private worktree dir
    // and stays outside the lock to keep the held section short.
    lock.withLock(() => {
      destroyAt(init.baseCwd, path)
      createWorktreeAt(init.baseCwd, path, init.baselineHead)
    })
    return overlayOwnedDiff(init.baseCwd, path, init.baselineHead, ownedFiles)
  }

  build(init.ownedFiles)

  return {
    path,
    baselineHead: init.baselineHead,
    refresh(ownedFiles: string[]): OverlayResult {
      // P1: full rebuild at baseline.head. Avoids the git-clean/info-exclude
      // interaction that an in-place incremental refresh would have to handle;
      // incremental refresh of only changed files is a P2+ optimization.
      return build(ownedFiles)
    },
    destroy(): void {
      lock.withLock(() => {
        destroyAt(init.baseCwd, path)
      })
    },
  }
}
