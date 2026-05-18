import { spawnSync } from 'node:child_process'
import type { WorkerArtifact } from './work-order.js'

interface GitResult {
  ok: boolean
  stdout: string
}

function git(cwd: string, args: string[]): GitResult {
  const result = spawnSync('git', args, {
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
 * @returns Unified diff string, or empty string on any error
 */
export function collectDiff(baseCwd: string, workerCwd: string, baseBranch: string): string {
  const branch = git(workerCwd, ['rev-parse', '--abbrev-ref', 'HEAD'])
  const workerBranch = branch.stdout.trim()
  if (!branch.ok || !workerBranch || workerBranch === 'HEAD') return ''

  const diff = git(baseCwd, ['diff', `${baseBranch}...${workerBranch}`])
  return diff.ok ? diff.stdout : ''
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

function extractChangedFiles(diff: string): string[] {
  const re = /^\+\+\+ b\/(.+)$/gm
  const files: string[] = []
  let m: RegExpExecArray | null
  while ((m = re.exec(diff)) !== null) {
    files.push(m[1]!)
  }
  return files
}
