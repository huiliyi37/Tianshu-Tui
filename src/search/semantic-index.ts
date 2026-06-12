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
}

export class SemanticIndex {
  private index = new BM25Index()
  private fileHashes = new Map<string, string>()
  private cwd: string

  constructor(cwd: string) {
    this.cwd = cwd
  }

  private indexPath(): string {
    return join(this.cwd, '.rivet', 'semantic-index.json')
  }

  private hashContent(content: string): string {
    return createHash('sha256').update(content).digest('hex').slice(0, 16)
  }

  /** Index a single file if changed. Returns true if re-indexed. */
  indexFile(relPath: string): boolean {
    const absPath = join(this.cwd, relPath)
    if (!existsSync(absPath)) {
      this.fileHashes.delete(relPath)
      return false
    }

    let content: string
    try {
      content = readFileSync(absPath, 'utf-8')
    } catch {
      return false
    }

    const hash = this.hashContent(content)
    if (this.fileHashes.get(relPath) === hash) return false

    this.fileHashes.set(relPath, hash)
    // Note: full rebuild per file is simpler for MVP; incremental chunk removal can follow
    return true
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
    const maxIndexed = 500
    const currentFiles = new Set<string>()
    let toReindex: string[] = []
    let toRemove: string[] = []

    // Collect current source files
    const walk = (dir: string, depth = 0): void => {
      if (depth > 8) return
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
    if (totalChanged > Math.max(10, totalIndexed * 0.2)) {
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
  if (idx.chunkCount === 0) idx.rebuild()
  return idx
}
