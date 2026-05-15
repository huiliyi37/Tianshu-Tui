import { execFile } from 'child_process'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs'
import { homedir } from 'os'
import { join } from 'path'
import { promisify } from 'util'

const execFileP = promisify(execFile)

export interface Checkpoint {
  hash: string
  timestamp: number
  message: string
}

interface CheckpointData {
  hash: string
  timestamp: number
  label: string
  cwd: string
}

const RIVET_DIR = join(homedir(), '.rivet')

function checkpointFile(cwd: string): string {
  // Per-project isolation: hash the cwd to avoid conflicts
  const slug = cwd.replace(/[^a-zA-Z0-9]/g, '_').slice(-64)
  return join(RIVET_DIR, `checkpoint-${slug}.json`)
}

function loadCheckpointData(cwd: string): CheckpointData | null {
  const file = checkpointFile(cwd)
  if (!existsSync(file)) return null
  try {
    return JSON.parse(readFileSync(file, 'utf-8')) as CheckpointData
  } catch {
    return null
  }
}

/** Create a checkpoint by recording the current HEAD hash. Does NOT stage or commit files. */
export async function createCheckpoint(cwd: string, label?: string): Promise<Checkpoint | null> {
  try {
    const { stdout } = await execFileP('git', ['rev-parse', 'HEAD'], {
      cwd, timeout: 5000, encoding: 'utf-8',
    })
    const hash = stdout.trim()

    mkdirSync(RIVET_DIR, { recursive: true })
    const msg = label ?? 'checkpoint'
    writeFileSync(checkpointFile(cwd), JSON.stringify({
      hash,
      timestamp: Date.now(),
      label: msg,
      cwd,
    }))

    return { hash, timestamp: Date.now(), message: msg }
  } catch {
    return null
  }
}

/** Preview what a rollback would discard. Returns null if no checkpoint or nothing to lose. */
export async function getRollbackPreview(cwd: string): Promise<string | null> {
  const data = loadCheckpointData(cwd)
  if (!data) return null

  try {
    const parts: string[] = []
    parts.push(`Checkpoint: ${data.hash.slice(0, 8)} (${new Date(data.timestamp).toLocaleString()})`)

    const { stdout: diff } = await execFileP('git', ['diff', '--stat', data.hash, 'HEAD'], {
      cwd, timeout: 5000, encoding: 'utf-8',
    })
    if (diff.trim()) parts.push(`\nCommitted changes:\n${diff.trim()}`)

    const { stdout: unstaged } = await execFileP('git', ['diff', '--stat'], {
      cwd, timeout: 5000, encoding: 'utf-8',
    })
    if (unstaged.trim()) parts.push(`\nUnstaged changes:\n${unstaged.trim()}`)

    const { stdout: staged } = await execFileP('git', ['diff', '--cached', '--stat'], {
      cwd, timeout: 5000, encoding: 'utf-8',
    })
    if (staged.trim()) parts.push(`\nStaged changes:\n${staged.trim()}`)

    const { stdout: untracked } = await execFileP('git', ['ls-files', '--others', '--exclude-standard'], {
      cwd, timeout: 5000, encoding: 'utf-8',
    })
    if (untracked.trim()) {
      const files = untracked.trim().split('\n').slice(0, 20)
      parts.push(`\nUntracked files to remove:\n${files.join('\n')}${untracked.trim().split('\n').length > 20 ? '\n... (more)' : ''}`)
    }

    if (!diff.trim() && !unstaged.trim() && !staged.trim() && !untracked.trim()) return null
    return parts.join('\n')
  } catch {
    return null
  }
}

/** Roll back to the last checkpoint. DESTRUCTIVE — call getRollbackPreview first. */
export async function rollbackToCheckpoint(cwd: string): Promise<{ success: boolean; hash?: string }> {
  const data = loadCheckpointData(cwd)
  if (!data) return { success: false }

  try {
    await execFileP('git', ['reset', '--hard', data.hash], {
      cwd, timeout: 10000,
    })
    await execFileP('git', ['clean', '-fd'], {
      cwd, timeout: 10000,
    })
    return { success: true, hash: data.hash.slice(0, 7) }
  } catch {
    return { success: false }
  }
}

/** List all rivet checkpoint commits. */
export function listCheckpoints(cwd: string): Checkpoint[] {
  const data = loadCheckpointData(cwd)
  if (!data) return []
  return [{ hash: data.hash.slice(0, 7), timestamp: data.timestamp, message: data.label }]
}