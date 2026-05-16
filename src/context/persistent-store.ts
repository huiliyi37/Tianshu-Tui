import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, unlinkSync, writeFileSync } from 'node:fs'
import { basename, join } from 'node:path'

export interface ArchiveEntry {
  id: string
  toolName: string
  content: string
  sessionId: string
  roundNumber: number
  timestamp: string
  size: number
}

export interface ArchiveInput {
  toolName: string
  content: string
  sessionId: string
  roundNumber: number
}

export interface SearchQuery {
  toolName?: string
  query?: string
  since?: string
  limit?: number
}

export interface StoreOptions {
  maxDiskBytes?: number
}

export class PersistentStore {
  private maxDiskBytes: number

  constructor(private dir: string, options?: StoreOptions) {
    this.maxDiskBytes = options?.maxDiskBytes ?? 100 * 1024 * 1024
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
  }

  archive(input: ArchiveInput): string {
    const timestamp = new Date().toISOString()
    const id = createHash('sha256')
      .update(`${input.sessionId}:${input.roundNumber}:${input.toolName}:${timestamp}:${input.content.length}`)
      .digest('hex')
      .slice(0, 16)
    const entry: ArchiveEntry = {
      id,
      ...input,
      timestamp,
      size: input.content.length,
    }

    writeFileSync(this.entryPath(id), JSON.stringify(entry), 'utf8')
    this.enforceLimit()
    return id
  }

  retrieve(id: string): ArchiveEntry | null {
    const path = this.entryPath(id)
    if (!existsSync(path)) return null
    try {
      return JSON.parse(readFileSync(path, 'utf8')) as ArchiveEntry
    } catch {
      return null
    }
  }

  search(query: SearchQuery): ArchiveEntry[] {
    const limit = query.limit ?? 5
    const entries: ArchiveEntry[] = []
    for (const file of this.entryFiles()) {
      try {
        const entry = JSON.parse(readFileSync(join(this.dir, file), 'utf8')) as ArchiveEntry
        if (query.toolName && entry.toolName !== query.toolName) continue
        if (query.query && !entry.content.includes(query.query)) continue
        if (query.since && entry.timestamp < query.since) continue
        entries.push(entry)
      } catch {
        continue
      }
    }
    return entries.sort((a, b) => b.timestamp.localeCompare(a.timestamp)).slice(0, limit)
  }

  private entryPath(id: string): string {
    return join(this.dir, `${basename(id)}.json`)
  }

  private entryFiles(): string[] {
    return readdirSync(this.dir).filter(file => file.endsWith('.json'))
  }

  private enforceLimit(): void {
    const entries = this.entryFiles().map(file => {
      const path = join(this.dir, file)
      const stats = statSync(path)
      return { file, size: stats.size, mtimeMs: stats.mtimeMs }
    }).sort((a, b) => a.mtimeMs - b.mtimeMs)

    let totalSize = entries.reduce((sum, entry) => sum + entry.size, 0)
    for (const entry of entries) {
      if (totalSize <= this.maxDiskBytes) return
      unlinkSync(join(this.dir, entry.file))
      totalSize -= entry.size
    }
  }
}
