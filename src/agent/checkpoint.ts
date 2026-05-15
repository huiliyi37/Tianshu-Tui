import { execSync } from 'child_process'

export interface Checkpoint {
  hash: string
  timestamp: number
  message: string
}

/** Create a git commit checkpoint before agent starts modifying files. */
export function createCheckpoint(cwd: string, label?: string): Checkpoint | null {
  try {
    // Stage all current changes first
    execSync('git add -A', { cwd, timeout: 10000, stdio: 'ignore' })

    const msg = label ? `rivet-checkpoint: ${label}` : 'rivet-checkpoint'
    execSync(`git commit --allow-empty -m "${msg}"`, {
      cwd, timeout: 10000, stdio: 'ignore',
    })

    const hash = execSync('git rev-parse HEAD', {
      cwd, timeout: 5000, encoding: 'utf-8',
    }).trim()

    return { hash, timestamp: Date.now(), message: msg }
  } catch {
    return null
  }
}

/** Roll back to the last rivet checkpoint commit. */
export function rollbackToCheckpoint(cwd: string): { success: boolean; hash?: string } {
  try {
    // Find the last rivet-checkpoint commit
    const hash = execSync(
      'git log --oneline -1 --grep="rivet-checkpoint" --format="%H"',
      { cwd, timeout: 5000, encoding: 'utf-8' },
    ).trim()

    if (!hash) {
      return { success: false }
    }

    execSync(`git reset --hard ${hash}`, {
      cwd, timeout: 10000, stdio: 'ignore',
    })

    // Clean untracked files created after checkpoint
    execSync('git clean -fd', {
      cwd, timeout: 10000, stdio: 'ignore',
    })

    return { success: true, hash: hash.slice(0, 7) }
  } catch {
    return { success: false }
  }
}

/** List all rivet checkpoint commits. */
export function listCheckpoints(cwd: string): Checkpoint[] {
  try {
    const output = execSync(
      'git log --oneline --grep="rivet-checkpoint" --format="%H %ct %s"',
      { cwd, timeout: 5000, encoding: 'utf-8' },
    ).trim()

    if (!output) return []

    return output.split('\n').map(line => {
      const [hash, timestamp, ...rest] = line.split(' ')
      return {
        hash: hash!.slice(0, 7),
        timestamp: parseInt(timestamp!, 10) * 1000,
        message: rest.join(' '),
      }
    })
  } catch {
    return []
  }
}

/**
 * Remove all rivet checkpoint commits by soft-resetting to before the first one.
 * Called on clean exit after successful task completion.
 */
export function cleanupCheckpoints(cwd: string): void {
  try {
    // Find the commit before the first checkpoint
    const firstCheckpoint = execSync(
      'git log --oneline --grep="rivet-checkpoint" --format="%H" | tail -1',
      { cwd, timeout: 5000, encoding: 'utf-8' },
    ).trim()

    if (!firstCheckpoint) return

    // Reset to before first checkpoint, keeping working tree changes
    execSync(`git reset --soft ${firstCheckpoint}^`, {
      cwd, timeout: 10000, stdio: 'ignore',
    })

    // Unstage everything
    execSync('git reset', { cwd, timeout: 5000, stdio: 'ignore' })
  } catch {
    // Best effort cleanup
  }
}
