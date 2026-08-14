import { spawnGitSync } from '../tools/spawn-git.js'
import { existsSync } from 'node:fs'
import { isAbsolute, join, relative, resolve } from 'node:path'

export interface ScopedCommitInput {
  cwd: string
  files: string[]
  message: string
}

export interface ScopedCommitResult {
  ok: boolean
  output: string
}

// ── Transient git lock retry ─────────────────────────────────────────
// index.lock contention is transient in multi-session workspaces (another
// git process exiting, a concurrent session mid-add). Bubbling it up to the
// LLM costs a full outer deliver_task retry (all pre-commit gates re-run,
// and the retried commit spawns a duplicate post-commit review worker).
// Retry in place with bounded backoff instead. The lock is NEVER deleted —
// it is likely held by a live process; on exhaustion the original error is
// returned unchanged.
const LOCK_RETRY_DELAYS_MS = [1000, 2000, 4000]

function isLockContention(output: string): boolean {
  const lower = output.toLowerCase()
  return lower.includes('index.lock') || lower.includes('unable to create') || lower.includes('another git process')
}

/** Synchronous sleep — commitScopedFiles is sync end-to-end (spawnGitSync).
 *  Atomics.wait signature: wait(array, index, EXPECTED_VALUE, timeout) — the
 *  expected value must be 0 (fresh buffer) or it returns 'not-equal' instantly. */
function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)
}

/** Classify owned paths before `git add`: a path missing from BOTH the worktree
 *  and the git index is stale — its deletion was already committed by another
 *  session. Staging it fails with a raw "pathspec did not match" error that
 *  costs a full outer deliver_task retry. Skip and report instead. A missing
 *  worktree copy still present in the index is a staged deletion (D status):
 *  `git add -- <path>` stages the removal, so it must be kept. */
function classifyStalePaths(cwd: string, files: string[]): { addable: string[]; stale: string[] } {
  const addable: string[] = []
  const missing: string[] = []
  for (const f of files) {
    if (existsSync(join(cwd, f))) addable.push(f)
    else missing.push(f)
  }
  if (missing.length === 0) return { addable, stale: [] }
  const ls = runGit(cwd, ['ls-files', '-z', '--', ...missing])
  const inIndex = new Set(ls.ok ? ls.output.split('\0').filter(Boolean) : [])
  const stale: string[] = []
  for (const f of missing) {
    if (inIndex.has(f)) addable.push(f) // deletion not yet staged — git add stages it
    else stale.push(f)                  // gone from the index too — committed externally
  }
  return { addable, stale }
}

export function commitScopedFiles(input: ScopedCommitInput): ScopedCommitResult {
  if (!input.message.trim()) return { ok: false, output: 'Commit message is required.' }

  const files = normalizeFiles(input.cwd, input.files)
  if (files.length === 0) return { ok: false, output: 'No owned files to commit.' }

  const { addable, stale } = classifyStalePaths(input.cwd, files)
  if (addable.length === 0) {
    return {
      ok: false,
      output: `No owned files to commit: every owned path is stale — already deleted and committed by another session: ${stale.join(', ')}. Refresh the owned set before retrying.`,
    }
  }
  const staleNote = stale.length > 0
    ? `⚠ Skipped ${stale.length} stale path(s) already committed externally: ${stale.join(', ')}\n`
    : ''

  for (let attempt = 0; ; attempt++) {
    // add is idempotent — safe to re-run when the commit step hit a lock.
    const add = runGit(input.cwd, ['add', '--', ...addable])
    if (!add.ok) {
      const delay = LOCK_RETRY_DELAYS_MS[attempt]
      if (delay !== undefined && isLockContention(add.output)) {
        sleepSync(delay)
        continue
      }
      return add
    }

    const commit = runGit(input.cwd, ['commit', '-m', input.message, '--only', '--', ...addable])
    if (!commit.ok) {
      const delay = LOCK_RETRY_DELAYS_MS[attempt]
      if (delay !== undefined && isLockContention(commit.output)) {
        sleepSync(delay)
        continue
      }
      // Provide friendlier error for common "nothing changed" case
      const lower = commit.output.toLowerCase()
      if (lower.includes('nothing to commit') || lower.includes('no changes')) {
        return { ok: false, output: `No changes in owned files to commit (${addable.join(', ')}). Files may have been committed already or not modified.` }
      }
    }
    if (!commit.ok) return commit
    return { ok: true, output: staleNote + commit.output }
  }
}

function normalizeFiles(cwd: string, files: string[]): string[] {
  const normalized = files
    .map(file => {
      const resolved = resolve(cwd, file)
      const rel = relative(cwd, resolved)
      if (rel === '' || rel.startsWith('..') || isAbsolute(rel)) return null
      return rel
    })
    .filter((file): file is string => file !== null)
  return [...new Set(normalized)].sort((a, b) => a.localeCompare(b))
}

function runGit(cwd: string, args: string[]): ScopedCommitResult {
  // Force C locale so git's porcelain/error text stays in parseable English
  // regardless of the user's system locale (e.g. zh_CN would print 无文件要提交).
  const result = spawnGitSync(args, {
    cwd,
    encoding: 'utf-8',
    timeout: 10_000,
    env: { ...process.env, LC_ALL: 'C', LANG: 'C' },
  })
  const output = `${result.stdout ?? ''}${result.stderr ?? ''}`.trim()
  if (result.status !== 0) return { ok: false, output: output || `git ${args[0] ?? 'command'} failed` }
  return { ok: true, output }
}
