import { readFileSync, existsSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import { createHash } from 'node:crypto'
import { MeridianDb } from './meridian-db.js'
import { MeridianBehavior } from './meridian-behavior.js'
import { parseTypeScriptFile, initParser } from './meridian-parser.js'
import { buildRepoMap } from './meridian-graph.js'
import type { RepoMapResult } from './meridian-types.js'
import type { RepoMapOptions } from './meridian-graph.js'
import type { StigmergyStore } from '../context/stigmergy.js'

const TS_EXTENSIONS = ['.ts', '.tsx', '.js', '.jsx']
const IGNORE_PATTERNS = ['node_modules', 'dist', '.git', '.rivet']

export class MeridianIndexer {
  private db: MeridianDb
  private behavior: MeridianBehavior
  private initialized = false
  private indexing = new Set<string>()

  constructor(private cwd: string, stateDir?: string, stigmergy?: StigmergyStore) {
    const dir = stateDir ?? resolve(cwd, '.rivet')
    this.db = new MeridianDb(dir)
    this.behavior = new MeridianBehavior(this.db, stigmergy)
  }

  private async ensureInit(): Promise<void> {
    if (!this.initialized) {
      await initParser()
      this.initialized = true
    }
  }

  async indexFile(filePath: string): Promise<void> {
    if (this.indexing.has(filePath)) return
    if (!this.isIndexable(filePath)) return

    const absPath = resolve(this.cwd, filePath)
    if (!existsSync(absPath)) return

    const source = readFileSync(absPath, 'utf-8')
    const hash = createHash('sha256').update(source).digest('hex').slice(0, 16)

    if (!this.db.needsParse(filePath, hash)) {
      this.db.recordAccess(filePath)
      return
    }

    await this.ensureInit()
    this.indexing.add(filePath)

    try {
      const result = await parseTypeScriptFile(filePath, source)
      this.db.upsertFile(result)
      this.db.recordAccess(filePath)

      // 1-hop expand: parse direct imports
      for (const imp of result.imports) {
        const resolved = this.resolveImport(filePath, imp)
        if (resolved && !this.indexing.has(resolved)) {
          await this.indexFile(resolved)
        }
      }
    } finally {
      this.indexing.delete(filePath)
    }
  }

  async invalidateFile(filePath: string): Promise<void> {
    if (!this.isIndexable(filePath)) return
    const absPath = resolve(this.cwd, filePath)
    if (!existsSync(absPath)) return

    await this.ensureInit()
    const source = readFileSync(absPath, 'utf-8')
    const result = await parseTypeScriptFile(filePath, source)
    this.db.upsertFile(result)
  }

  async query(seedFile: string, opts?: Partial<RepoMapOptions>): Promise<RepoMapResult> {
    await this.behavior.refreshPheromoneCache()
    return buildRepoMap(this.db, seedFile, {
      maxHops: opts?.maxHops ?? 3,
      decay: opts?.decay ?? 0.5,
      maxTokens: opts?.maxTokens ?? 2000,
      behavior: this.behavior,
    })
  }

  recordEdit(filePath: string, turn: number): void {
    this.behavior.recordEdit(filePath, turn)
  }

  flushTurn(): void {
    this.behavior.flushCoEdits()
  }

  getStats() {
    return this.db.getStats()
  }

  close(): void {
    this.db.close()
  }

  private isIndexable(filePath: string): boolean {
    if (IGNORE_PATTERNS.some(p => filePath.includes(p))) return false
    return TS_EXTENSIONS.some(ext => filePath.endsWith(ext))
  }

  private resolveImport(fromFile: string, importPath: string): string | null {
    const baseDir = dirname(resolve(this.cwd, fromFile))
    for (const ext of TS_EXTENSIONS) {
      const withExt = resolve(baseDir, importPath.replace(/\.[jt]sx?$/, '') + ext)
      if (existsSync(withExt)) {
        return withExt.slice(resolve(this.cwd).length + 1)
      }
      const indexFile = resolve(baseDir, importPath, 'index' + ext)
      if (existsSync(indexFile)) {
        return indexFile.slice(resolve(this.cwd).length + 1)
      }
    }
    return null
  }
}
