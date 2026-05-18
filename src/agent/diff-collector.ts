import { execSync } from 'node:child_process'
import type { WorkerArtifact } from './work-order.js'

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
  try {
    // Get the worker's current branch from the worktree
    const workerBranch = execSync('git rev-parse --abbrev-ref HEAD', {
      cwd: workerCwd, encoding: 'utf-8', stdio: 'pipe',
    }).trim()

    if (!workerBranch || workerBranch === 'HEAD') return ''

    // Diff between base and worker branch (triple-dot = changes on worker since fork)
    return execSync(`git diff ${baseBranch}...${workerBranch}`, {
      cwd: baseCwd, encoding: 'utf-8', stdio: 'pipe',
    })
  } catch {
    return ''
  }
}

/**
 * Convert a diff string into a WorkerArtifact suitable for inclusion in WorkerResult.
 */
export function formatDiffArtifact(diff: string, _profile: string): WorkerArtifact {
  const files = extractChangedFiles(diff)
  return {
    kind: 'diff',
    title: files.length > 0 ? `Patch: ${files.join(', ')}` : 'Patch (empty)',
    content: diff,
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
