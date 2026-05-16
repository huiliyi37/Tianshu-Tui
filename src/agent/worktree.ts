import { execSync } from 'node:child_process'
import { mkdtempSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

export interface WorktreeEntry {
  path: string
  commit: string
  branch: string
}

// git worktree list output: "<path>  <commit> [<branch>]"
const WORKTREE_RE = /^(\S+)\s+(\w+)\s+\[(.+?)\]$/

export function parseWorktreeList(output: string): WorktreeEntry[] {
  return output
    .trim()
    .split('\n')
    .filter(Boolean)
    .map(line => {
      const m = WORKTREE_RE.exec(line)
      if (!m) return null
      return { path: m[1]!, commit: m[2]!, branch: m[3]! }
    })
    .filter((e): e is WorktreeEntry => e !== null)
}

export function buildWorktreeArgs(path: string, branch?: string): string[] {
  return branch ? ['worktree', 'add', '-b', branch, path] : ['worktree', 'add', '--detach', path]
}

export function createWorktree(cwd: string, sessionId: string): string {
  const wtPath = mkdtempSync(join(tmpdir(), `rivet-wt-${sessionId.slice(0, 8)}-`))
  const args = buildWorktreeArgs(wtPath, `rivet-session-${sessionId.slice(0, 8)}`)
  execSync(`git ${args.join(' ')}`, { cwd, stdio: 'pipe' })
  return wtPath
}

export function removeWorktree(cwd: string, wtPath: string): void {
  try {
    execSync(`git worktree remove --force "${wtPath}"`, { cwd, stdio: 'pipe' })
  } catch {
    // best effort cleanup
  }
}

export function listWorktrees(cwd: string): WorktreeEntry[] {
  try {
    const output = execSync('git worktree list', { cwd, encoding: 'utf-8', stdio: 'pipe' })
    return parseWorktreeList(output)
  } catch {
    return []
  }
}
