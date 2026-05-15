import { execSync } from 'child_process'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs'
import { homedir } from 'os'
import { join } from 'path'

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
const CHECKPOINT_FILE = join(RIVET_DIR, 'checkpoint.json')

function loadCheckpointData(): CheckpointData | null {
  if (!existsSync(CHECKPOINT_FILE)) return null
  try {
    return JSON.parse(readFileSync(CHECKPOINT_FILE, 'utf-8')) as CheckpointData
  } catch {
    return null
  }
}

/** Create a checkpoint by recording the current HEAD hash. Does NOT stage or commit files. */
export function createCheckpoint(cwd: string, label?: string): Checkpoint | null {
  try {
    const hash = execSync('git rev-parse HEAD', {
      cwd, timeout: 5000, encoding: 'utf-8',
    }).trim()

    mkdirSync(RIVET_DIR, { recursive: true })
    const msg = label ?? 'checkpoint'
    writeFileSync(CHECKPOINT_FILE, JSON.stringify({
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
export function getRollbackPreview(cwd: string): string | null {
  const data = loadCheckpointData()
  if (!data) return null

  try {
    const parts: string[] = []
    parts.push(`Checkpoint: ${data.hash.slice(0, 8)} (${new Date(data.timestamp).toLocaleString()})`)

    // Committed changes since checkpoint
    const diff = execSync(`git diff --stat ${data.hash} HEAD`, {
      cwd, timeout: 5000, encoding: 'utf-8',
    }).trim()
    if (diff) {
      parts.push(`\nCommitted changes:\n${diff}`)
    }

    // Unstaged/staged changes (not yet committed)
    const unstaged = execSync('git diff --stat', {
      cwd, timeout: 5000, encoding: 'utf-8',
    }).trim()
    if (unstaged) {
      parts.push(`\nUnstaged changes:\n${unstaged}`)
    }

    const staged = execSync('git diff --cached --stat', {
      cwd, timeout: 5000, encoding: 'utf-8',
    }).trim()
    if (staged) {
      parts.push(`\nStaged changes:\n${staged}`)
    }

    // Untracked files
    const untracked = execSync('git ls-files --others --exclude-standard', {
      cwd, timeout: 5000, encoding: 'utf-8',
    }).trim()
    if (untracked) {
      const files = untracked.split('\n').slice(0, 20)
      parts.push(`\nUntracked files to remove:\n${files.join('\n')}${untracked.split('\n').length > 20 ? '\n... (more)' : ''}`)
    }

    if (!diff && !unstaged && !staged && !untracked) return null

    return parts.join('\n')
  } catch {
    return null
  }
}

/** Roll back to the last checkpoint. DESTRUCTIVE — call getRollbackPreview first. */
export function rollbackToCheckpoint(cwd: string): { success: boolean; hash?: string } {
  const data = loadCheckpointData()
  if (!data) return { success: false }

  try {
    execSync(`git reset --hard ${data.hash}`, {
      cwd, timeout: 10000, stdio: 'ignore',
    })
    execSync('git clean -fd', {
      cwd, timeout: 10000, stdio: 'ignore',
    })
    return { success: true, hash: data.hash.slice(0, 7) }
  } catch {
    return { success: false }
  }
}

/** List all rivet checkpoint commits. */
export function listCheckpoints(_cwd: string): Checkpoint[] {
  const data = loadCheckpointData()
  if (!data) return []
  return [{ hash: data.hash.slice(0, 7), timestamp: data.timestamp, message: data.label }]
}
