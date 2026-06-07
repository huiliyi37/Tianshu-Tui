import { execFile } from 'child_process'
import { existsSync, mkdirSync, readFileSync, rmSync } from 'fs'
import { writeFileAtomicSync } from '../fs-atomic.js'
import { homedir } from 'os'
import { join } from 'path'
import { promisify } from 'util'

const execFileP = promisify(execFile)

export interface Checkpoint {
  hash: string
  timestamp: number
  message: string
}

export interface RollbackPreview {
  text: string
  confirmationToken: string
}

interface CheckpointData {
  version: 2
  hash: string
  timestamp: number
  label: string
  cwd: string
  sessionId?: string  // absent in legacy checkpoints
  preExistingDirtyFiles: string[]
  preExistingUntrackedFiles: string[]
  agentTouchedFiles: string[]
  confirmationToken?: string
}

const RIVET_DIR = join(homedir(), '.rivet')

function checkpointFile(cwd: string): string {
  const slug = cwd.replace(/[^a-zA-Z0-9]/g, '_').slice(-64)
  return join(RIVET_DIR, `checkpoint-${slug}.json`)
}

/** Returns the checkpoint file path scoped to a session ID. */
export function checkpointFileForSession(sessionId: string): string {
  return join(RIVET_DIR, `checkpoint-${sessionId}.json`)
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

/** Load checkpoint data scoped by session ID. */
function loadCheckpointDataForSession(sessionId: string): CheckpointData | null {
  const file = checkpointFileForSession(sessionId)
  if (!existsSync(file)) return null
  try {
    return JSON.parse(readFileSync(file, 'utf-8')) as CheckpointData
  } catch {
    return null
  }
}

// ─── Checkpoint Index (cross-session discovery per cwd) ───

export interface CheckpointIndexEntry {
  sessionId: string
  files: string[]
  timestamp: number
}

function checkpointIndexFile(cwd: string): string {
  const slug = cwd.replace(/[^a-zA-Z0-9]/g, '_').slice(-64)
  return join(RIVET_DIR, `checkpoint-index-${slug}.json`)
}

export function loadCheckpointIndex(cwd: string): CheckpointIndexEntry[] {
  const file = checkpointIndexFile(cwd)
  if (!existsSync(file)) return []
  try {
    return JSON.parse(readFileSync(file, 'utf-8')) as CheckpointIndexEntry[]
  } catch {
    return []
  }
}

export function addToCheckpointIndex(cwd: string, sessionId: string, files: string[]): void {
  const index = loadCheckpointIndex(cwd)
  const existing = index.findIndex(e => e.sessionId === sessionId)
  const entry: CheckpointIndexEntry = { sessionId, files, timestamp: Date.now() }
  if (existing >= 0) {
    index[existing] = entry
  } else {
    index.push(entry)
  }
  writeFileAtomicSync(checkpointIndexFile(cwd), JSON.stringify(index, null, 2))
}

export function removeFromCheckpointIndex(cwd: string, sessionId: string): void {
  const index = loadCheckpointIndex(cwd).filter(e => e.sessionId !== sessionId)
  writeFileAtomicSync(checkpointIndexFile(cwd), JSON.stringify(index, null, 2))
}

async function gitLines(cwd: string, args: string[]): Promise<string[]> {
  const { stdout } = await execFileP('git', ['-c', 'core.quotePath=false', ...args], { cwd, timeout: 5000, encoding: 'utf-8' })
  return stdout.split('\n').map(s => s.trim()).filter(Boolean)
}

async function getDirtySnapshot(cwd: string): Promise<{ dirty: string[]; untracked: string[] }> {
  const dirty = await gitLines(cwd, ['diff', '--name-only'])
  const staged = await gitLines(cwd, ['diff', '--cached', '--name-only'])
  const untracked = await gitLines(cwd, ['ls-files', '--others', '--exclude-standard'])
  return {
    dirty: [...new Set([...dirty, ...staged])].sort(),
    untracked: [...new Set(untracked)].sort(),
  }
}

/** Create a checkpoint by recording the current HEAD hash and dirty worktree state. */
export async function createCheckpoint(cwd: string, label?: string, sessionId?: string): Promise<Checkpoint | null> {
  try {
    const { stdout } = await execFileP('git', ['rev-parse', 'HEAD'], {
      cwd, timeout: 5000, encoding: 'utf-8',
    })
    const hash = stdout.trim()
    const snapshot = await getDirtySnapshot(cwd)

    mkdirSync(RIVET_DIR, { recursive: true })
    const msg = label ?? 'checkpoint'
    const data: CheckpointData = {
      version: 2,
      hash,
      timestamp: Date.now(),
      label: msg,
      cwd,
      ...(sessionId ? { sessionId } : {}),
      preExistingDirtyFiles: snapshot.dirty,
      preExistingUntrackedFiles: snapshot.untracked,
      agentTouchedFiles: [],
    }

    const file = sessionId ? checkpointFileForSession(sessionId) : checkpointFile(cwd)
    writeFileAtomicSync(file, JSON.stringify(data, null, 2))

    if (sessionId) {
      addToCheckpointIndex(cwd, sessionId, [])
    }

    return { hash, timestamp: data.timestamp, message: msg }
  } catch {
    return null
  }
}

/** Record that the agent touched a file — used for safe rollback scoping.
 *
 *  Race note: this is a read-modify-write on the checkpoint JSON file.
 *  In Node's single-threaded event loop with synchronous fs calls, two
 *  calls cannot interleave — each runs to completion before the next
 *  starts. The writeFileAtomicSync (tmp+rename) ensures individual writes
 *  are atomic. The only theoretical risk is two rapid calls in the same
 *  async tick both reading before either writes, but tool-pipeline.ts
 *  calls this synchronously per-tool in a sequential batch, so the
 *  read→modify→write window is effectively serialized. */
export function recordAgentTouchedFile(cwd: string, file: string, sessionId?: string): void {
  const data = sessionId ? loadCheckpointDataForSession(sessionId) : loadCheckpointData(cwd)
  if (!data) return
  const normalized = file.replace(/^\.\//, '')
  if (normalized.startsWith('/') || normalized.includes('..')) return
  data.agentTouchedFiles = [...new Set([...data.agentTouchedFiles, normalized])].sort()
  const outFile = sessionId ? checkpointFileForSession(sessionId) : checkpointFile(cwd)
  writeFileAtomicSync(outFile, JSON.stringify(data, null, 2))
}

/** Preview what a rollback would affect. Returns null if nothing to rollback. */
export async function getRollbackPreview(cwd: string, sessionId?: string): Promise<RollbackPreview | null> {
  const data = sessionId
    ? (loadCheckpointDataForSession(sessionId) ?? loadCheckpointData(cwd))
    : loadCheckpointData(cwd)
  if (!data) return null

  const token = Math.random().toString(36).slice(2, 10)
  data.confirmationToken = token
  // Write back to the same file we loaded from (session-scoped or legacy cwd-scoped)
  const file = (sessionId && data.sessionId === sessionId) ? checkpointFileForSession(sessionId) : checkpointFile(cwd)
  writeFileAtomicSync(file, JSON.stringify(data, null, 2))

  const protectedFiles = new Set([...data.preExistingDirtyFiles, ...data.preExistingUntrackedFiles])
  const rollbackFiles = data.agentTouchedFiles.filter(f => !protectedFiles.has(f))

  if (rollbackFiles.length === 0) return null

  const text = [
    `Checkpoint: ${data.hash.slice(0, 8)} (${new Date(data.timestamp).toLocaleString()})`,
    'Agent-owned files to restore/remove:',
    ...rollbackFiles.map(f => `- ${f}`),
  ].join('\n')

  return { text, confirmationToken: token }
}

/** Roll back only agent-owned files. Requires a valid confirmation token from preview. */
export async function rollbackToCheckpoint(
  cwd: string,
  confirmationToken?: string,
  sessionId?: string,
): Promise<{ success: boolean; hash?: string }> {
  const data = sessionId
    ? (loadCheckpointDataForSession(sessionId) ?? loadCheckpointData(cwd))
    : loadCheckpointData(cwd)
  if (!data || !confirmationToken || confirmationToken !== data.confirmationToken) {
    return { success: false }
  }

  const protectedFiles = new Set([...data.preExistingDirtyFiles, ...data.preExistingUntrackedFiles])
  const files = data.agentTouchedFiles.filter(f => !protectedFiles.has(f))
  if (files.length === 0) return { success: false }

  try {
    for (const file of files) {
      const trackedAtHead = await execFileP('git', ['cat-file', '-e', `${data.hash}:${file}`], { cwd })
        .then(() => true)
        .catch(() => false)
      if (trackedAtHead) {
        await execFileP('git', ['checkout', data.hash, '--', file], { cwd, timeout: 10000 })
      } else {
        const fullPath = join(cwd, file)
        if (existsSync(fullPath)) rmSync(fullPath, { recursive: true, force: true })
      }
    }
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
