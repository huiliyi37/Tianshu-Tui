import { existsSync, mkdirSync, readFileSync, writeFileSync, renameSync, unlinkSync, openSync, closeSync } from 'node:fs'
import { join } from 'node:path'
import { randomBytes } from 'node:crypto'

const MAX_ENTRIES = 200
const MAX_FILE_SIZE = 16_384 // 16KB
const LOCK_RETRY_MAX_MS = 500
const LOCK_RETRY_INTERVAL_MS = 20

interface MemoryEntry {
  id: string
  kind: string
  text: string
  confidence: number
  createdAt: number
  source: string
  tags?: string[]
}

/**
 * Acquire an advisory lock by creating a .lock file with O_CREAT|O_EXCL.
 * Retries with backoff up to LOCK_RETRY_MAX_MS. Returns a cleanup function
 * that removes the lock file.
 *
 * Without this lock, concurrent `remember(project)` calls across sessions
 * sharing the same cwd would interleave reads and writes, losing entries
 * (violating the atomic/monotonic invariant from 891cc1b6).
 */
function acquireLock(lockPath: string): () => void {
  const start = Date.now()
  while (true) {
    try {
      const fd = openSync(lockPath, 'wx') // O_CREAT|O_EXCL
      // Write PID for diagnostics
      writeFileSync(fd, String(process.pid), 'utf-8')
      closeSync(fd)
      return () => {
        try { unlinkSync(lockPath) } catch { /* lock already released */ }
      }
    } catch {
      if (Date.now() - start > LOCK_RETRY_MAX_MS) {
        // Last attempt: force through without lock (existing behavior fallback)
        return () => {}
      }
      // Busy-wait is acceptable here — lock duration is sub-ms for append
      const waitUntil = Date.now() + LOCK_RETRY_INTERVAL_MS
      while (Date.now() < waitUntil) { /* spin */ }
    }
  }
}

/**
 * Write content to a temp file then atomically rename to target path.
 * This guarantees readers never see a partial write.
 */
function atomicWrite(targetPath: string, content: string): void {
  const dir = join(targetPath, '..')
  const tmpName = `.memory.${randomBytes(4).toString('hex')}.tmp`
  const tmpPath = join(dir, tmpName)
  writeFileSync(tmpPath, content, 'utf-8')
  renameSync(tmpPath, targetPath)
}

export function appendProjectMemory(
  cwd: string,
  claim: { id: string; kind: string; text: string; confidence: number; createdAt: number; evidence?: Array<{ summary?: string }>; tags?: string[] },
): void {
  const dir = join(cwd, '.rivet', 'knowledge')
  mkdirSync(dir, { recursive: true })
  const path = join(dir, 'memory.jsonl')
  const lockPath = join(dir, 'memory.jsonl.lock')

  const entry: MemoryEntry = {
    id: claim.id,
    kind: claim.kind,
    text: claim.text,
    confidence: claim.confidence,
    createdAt: claim.createdAt,
    source: claim.evidence?.[0]?.summary ?? 'unknown',
    ...(claim.tags && claim.tags.length > 0 ? { tags: claim.tags } : {}),
  }

  const release = acquireLock(lockPath)
  try {
    // Read existing, append, atomic write
    let existing = ''
    if (existsSync(path)) {
      try { existing = readFileSync(path, 'utf-8') } catch { /* treat as empty */ }
    }
    const newContent = existing + JSON.stringify(entry) + '\n'
    atomicWrite(path, newContent)
  } finally {
    release()
  }
}

/**
 * Compact project memory: deduplicate by id and trim to MAX_ENTRIES
 * by confidence (desc). Returns number of entries removed.
 */
export function compactProjectMemory(cwd: string): number {
  const dir = join(cwd, '.rivet', 'knowledge')
  const path = join(dir, 'memory.jsonl')
  const lockPath = join(dir, 'memory.jsonl.lock')
  if (!existsSync(path)) return 0

  const release = acquireLock(lockPath)
  try {
    const entries: MemoryEntry[] = []
    let fileSize = 0
    try {
      const raw = readFileSync(path, 'utf-8')
      fileSize = raw.length
      const lines = raw.split('\n').filter(l => l.trim())
      for (const line of lines) {
        try {
          const parsed = JSON.parse(line)
          if (parsed.id && parsed.text) entries.push(parsed)
        } catch { /* skip malformed lines */ }
      }
    } catch {
      return 0
    }

    // Deduplicate by id
    const seen = new Map<string, MemoryEntry>()
    for (const entry of entries) {
      seen.set(entry.id, entry)
    }

    // Sort by confidence desc, then createdAt desc
    const kept = [...seen.values()]
      .sort((a, b) => b.confidence - a.confidence || b.createdAt - a.createdAt)
      .slice(0, MAX_ENTRIES)

    // Write back only if changed
    if (kept.length < entries.length || fileSize > MAX_FILE_SIZE) {
      atomicWrite(path, kept.map(e => JSON.stringify(e)).join('\n') + '\n')
      return entries.length - kept.length
    }

    return 0
  } finally {
    release()
  }
}
