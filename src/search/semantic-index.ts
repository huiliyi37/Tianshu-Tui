/**
 * Semantic index — file-level BM25 index with incremental updates.
 */

import { existsSync, readFileSync, readdirSync, statSync, writeFileSync, mkdirSync } from 'node:fs'
import { join, relative } from 'node:path'
import { createHash } from 'node:crypto'
import { BM25Index, chunkFileContent } from './text-index.js'

const INDEX_VERSION = 1
const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', 'build', '.rivet', 'coverage'])
const SOURCE_EXT = new Set(['.ts', '.tsx', '.js', '.jsx', '.md', '.json'])

export interface SemanticIndexSnapshot {
  version: number
  fileHashes: Record<string, string>
  chunkCount: number
  builtAt: number
  /** Lightweight chunk refs for cold-start restore (excludes terms — regenerated from text). */
  chunks?: Array<{ file: string; startLine: number; endLine: number; text: string }>
}

export class SemanticIndex {
  private index = new BM25Index()
  private fileHashes = new Map<string, string>()
  private cwd: string

  constructor(cwd: string) {
    this.cwd = cwd
    this.loadMeta()
  }

  private indexPath(): string {
    return join(this.cwd, '.rivet', 'semantic-index.json')
  }

  private hashContent(content: string): string {
    return createHash('sha256').update(content).digest('hex').slice(0, 16)
  }

  /** Load persisted snapshot on cold start. Restores fileHashes and chunks so
   *  isStale() works immediately and searches succeed without a full rebuild. */
  private loadMeta(): void {
    const path = this.indexPath()
    if (!existsSync(path)) return
    try {
      const raw = readFileSync(path, 'utf-8')
      const snapshot = JSON.parse(raw) as SemanticIndexSnapshot
      if (snapshot.version === INDEX_VERSION && snapshot.fileHashes) {
        for (const [relPath, hash] of Object.entries(snapshot.fileHashes)) {
          this.fileHashes.set(relPath, hash)
        }
        // Restore chunks so cold-start searches work without rebuild
        if (snapshot.chunks) {
          for (const c of snapshot.chunks) {
            this.index.addChunk(c.file, c.startLine, c.endLine, c.text)
          }
        }
      }
    } catch {
      // Corrupt snapshot — rebuild on first ensureSemanticIndex call
    }
  }

  /** Full rebuild of the semantic index from source tree. */
  rebuild(maxFiles = 500): { indexed: number; skipped: number } {
    this.index.clear()
    this.fileHashes.clear()
    let indexed = 0
    let skipped = 0

    const walk = (dir: string, depth = 0): void => {
      if (depth > 8 || indexed >= maxFiles) return
      let entries: string[]
      try {
        entries = readdirSync(dir)
      } catch {
        return
      }

      for (const entry of entries) {
        if (indexed >= maxFiles) break
        if (SKIP_DIRS.has(entry)) continue
        const abs = join(dir, entry)
        let st: ReturnType<typeof statSync>
        try {
          st = statSync(abs)
        } catch {
          continue
        }

        if (st.isDirectory()) {
          walk(abs, depth + 1)
        } else if (st.isFile()) {
          const ext = entry.slice(entry.lastIndexOf('.'))
          if (!SOURCE_EXT.has(ext)) {
            skipped++
            continue
          }
          const rel = relative(this.cwd, abs)
          let content: string
          try {
            content = readFileSync(abs, 'utf-8')
          } catch {
            skipped++
            continue
          }
          if (content.length > 200_000) {
            skipped++
            continue
          }

          const hash = this.hashContent(content)
          this.fileHashes.set(rel, hash)
          const chunks = chunkFileContent(content)
          let lineOffset = 0
          for (const chunk of chunks) {
            const chunkLines = chunk.split('\n').length
            this.index.addChunk(rel, lineOffset + 1, lineOffset + chunkLines, chunk)
            lineOffset += chunkLines
          }
          indexed++
        }
      }
    }

    walk(this.cwd)
    this.persistMeta()
    return { indexed, skipped }
  }

  /** Check if the index is stale by comparing file hashes against the current filesystem. */
  isStale(): boolean {
    // Quick count check: new files added since last index
    let diskCount = 0
    try {
      const walk = (dir: string, depth = 0): void => {
        if (depth > 8 || diskCount > this.fileHashes.size + 10) return
        let entries: string[]
        try { entries = readdirSync(dir) } catch { return }
        for (const entry of entries) {
          if (SKIP_DIRS.has(entry)) continue
          const abs = join(dir, entry)
          let st: ReturnType<typeof statSync>
          try { st = statSync(abs) } catch { continue }
          if (st.isDirectory()) { walk(abs, depth + 1) }
          else if (st.isFile()) {
            const ext = entry.slice(entry.lastIndexOf('.'))
            if (SOURCE_EXT.has(ext)) diskCount++
          }
        }
      }
      walk(this.cwd)
    } catch { /* count failure → fall through to hash check */ }
    if (diskCount > this.fileHashes.size) return true

    for (const [relPath, storedHash] of this.fileHashes) {
      const absPath = join(this.cwd, relPath)
      if (!existsSync(absPath)) return true // file deleted
      try {
        const content = readFileSync(absPath, 'utf-8')
        if (this.hashContent(content) !== storedHash) return true
      } catch {
        return true // unreadable
      }
    }
    return false
  }

  /** Incrementally update the index: detect changed/new/deleted files and re-index.
   *  Falls back to full rebuild when more than 20% of files have changed. */
  incrementalUpdate(): { reindexed: number; removed: number; fallbackRebuild: boolean } {
    const maxFiles = 500
    let scanned = 0
    const currentFiles = new Set<string>()
    let toReindex: string[] = []
    let toRemove: string[] = []

    // Collect current source files
    const walk = (dir: string, depth = 0): void => {
      if (depth > 8 || scanned >= maxFiles) return
      let entries: string[]
      try {
        entries = readdirSync(dir)
      } catch {
        return
      }
      for (const entry of entries) {
        if (SKIP_DIRS.has(entry)) continue
        const abs = join(dir, entry)
        let st: ReturnType<typeof statSync>
        try { st = statSync(abs) } catch { continue }
        if (st.isDirectory()) { walk(abs, depth + 1) }
        else if (st.isFile()) {
          const ext = entry.slice(entry.lastIndexOf('.'))
          if (!SOURCE_EXT.has(ext)) continue
          const rel = relative(this.cwd, abs)
          currentFiles.add(rel)
          scanned++
        }
      }
    }
    walk(this.cwd)

    // Find deleted files (in index but not on disk)
    for (const relPath of this.fileHashes.keys()) {
      if (!currentFiles.has(relPath)) toRemove.push(relPath)
    }

    // Find new/modified files
    for (const relPath of currentFiles) {
      const absPath = join(this.cwd, relPath)
      try {
        const content = readFileSync(absPath, 'utf-8')
        if (content.length > 200_000) continue
        const hash = this.hashContent(content)
        if (this.fileHashes.get(relPath) !== hash) toReindex.push(relPath)
      } catch {
        toRemove.push(relPath)
      }
    }

    // Fallback: if too many files changed, do a full rebuild
    const totalChanged = toRemove.length + toReindex.length
    const totalIndexed = this.fileHashes.size
    if (totalChanged >= Math.max(2, totalIndexed * 0.2)) {
      return this.rebuildWithResult(0, 0)
    }

    // Remove deleted files from index
    for (const relPath of toRemove) {
      this.index.removeFileChunks(relPath)
      this.fileHashes.delete(relPath)
    }

    // Re-index changed files
    let reindexed = 0
    for (const relPath of toReindex) {
      // Remove old chunks first
      this.index.removeFileChunks(relPath)
      this.fileHashes.delete(relPath)

      const absPath = join(this.cwd, relPath)
      try {
        const content = readFileSync(absPath, 'utf-8')
        const hash = this.hashContent(content)
        this.fileHashes.set(relPath, hash)
        const chunks = chunkFileContent(content)
        let lineOffset = 0
        for (const chunk of chunks) {
          const chunkLines = chunk.split('\n').length
          this.index.addChunk(relPath, lineOffset + 1, lineOffset + chunkLines, chunk)
          lineOffset += chunkLines
        }
        reindexed++
      } catch { /* skip unreadable */ }
    }

    this.persistMeta()
    return { reindexed, removed: toRemove.length, fallbackRebuild: false }
  }

  private rebuildWithResult(indexed: number, skipped: number): { reindexed: number; removed: number; fallbackRebuild: boolean } {
    const result = this.rebuild()
    return { reindexed: result.indexed, removed: 0, fallbackRebuild: true }
  }

  search(query: string, limit = 10) {
    return this.index.search(query, limit)
  }

  get chunkCount(): number {
    return this.index.size
  }

  persistMeta(): void {
    const dir = join(this.cwd, '.rivet')
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
    const snapshot: SemanticIndexSnapshot = {
      version: INDEX_VERSION,
      fileHashes: Object.fromEntries(this.fileHashes),
      chunkCount: this.index.size,
      builtAt: Date.now(),
      chunks: this.index.getChunkRefs(),
    }
    writeFileSync(this.indexPath(), JSON.stringify(snapshot, null, 2), 'utf-8')
  }
}

/** Module-level cache per cwd */
const indexCache = new Map<string, SemanticIndex>()

export function getSemanticIndex(cwd: string): SemanticIndex {
  let idx = indexCache.get(cwd)
  if (!idx) {
    idx = new SemanticIndex(cwd)
    indexCache.set(cwd, idx)
  }
  return idx
}

export function ensureSemanticIndex(cwd: string): SemanticIndex {
  const idx = getSemanticIndex(cwd)
  // Cold start with persisted snapshot: chunks loaded from disk → skip rebuild.
  // Only rebuild when index is truly empty (never built) or stale (files changed).
  if (idx.chunkCount === 0) idx.rebuild()
  else if (idx.isStale()) idx.incrementalUpdate()
  return idx
}
