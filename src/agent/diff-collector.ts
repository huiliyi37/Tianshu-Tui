import { spawnGitSync } from '../tools/spawn-git.js'
import type { WorkerArtifact } from './work-order.js'

interface GitResult {
  ok: boolean
  stdout: string
}

function git(cwd: string, args: string[]): GitResult {
  const result = spawnGitSync(args, {
    cwd,
    encoding: 'utf-8',
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  return {
    ok: result.status === 0,
    stdout: typeof result.stdout === 'string' ? result.stdout : '',
  }
}

/**
 * Collect a git diff between a base branch and the HEAD of a worker worktree.
 * The worktree is assumed to be on its own branch with committed changes.
 *
 * @param baseCwd  Primary session working directory (where the base branch lives)
 * @param workerCwd  Worker's worktree directory
 * @param baseBranch  The branch to diff against (e.g. "main")
 * @param excludePaths  Repo-relative paths to leave out of the diff. Used for
 *   scope files materialized into the worktree (untracked inputs copied from
 *   the base repo): they are not worker output, and since 9caae143 linked
 *   worktrees no longer hide them via the shared info/exclude, so they must be
 *   filtered here — otherwise they surface as "new file" hunks that fail to
 *   apply back onto the base repo where the untracked original already exists.
 * @returns Unified diff string, or empty string on any error
 */
export function collectDiff(_baseCwd: string, workerCwd: string, baseBranch: string, excludePaths: string[] = []): string {
  // Capture every mutation in the worker worktree before it is destroyed.
  // Committed worker branch changes are visible relative to baseBranch, while
  // staged/unstaged/untracked changes are captured by staging the isolated
  // worktree and diffing its index against HEAD.
  const parts: string[] = []
  const pathspec = excludePaths.length > 0
    ? ['--', '.', ...excludePaths.map(p => `:(exclude)${p}`)]
    : []

  const committed = git(workerCwd, ['diff', `${baseBranch}...HEAD`, ...pathspec])
  if (committed.ok && committed.stdout.trim()) {
    parts.push(committed.stdout)
  }

  // `git add -A` is safe here because hands-session owns and removes this
  // isolated worktree after diff collection.
  git(workerCwd, ['add', '-A', ...pathspec])
  const staged = git(workerCwd, ['diff', '--cached', 'HEAD', ...pathspec])
  if (staged.ok && staged.stdout.trim()) {
    parts.push(staged.stdout)
  }

  return parts.join('')
}

/**
 * Convert a diff string into a WorkerArtifact suitable for inclusion in WorkerResult.
 */
export function formatDiffArtifact(diff: string, _profile: string): WorkerArtifact {
  const files = extractChangedFiles(diff)
  return {
    kind: 'diff',
    title: files.length > 0 ? `Patch: ${files.join(', ')}` : 'Patch (empty)',
    content: diff.length > 0 ? diff : '(empty diff)',
  }
}

export function extractChangedFiles(diff: string): string[] {
  const re = /^\+\+\+ b\/(.+)$/gm
  const files: string[] = []
  let m: RegExpExecArray | null
  while ((m = re.exec(diff)) !== null) {
    files.push(m[1]!)
  }
  return files
}
