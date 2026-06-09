import { readFileSync, existsSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import { createHash } from 'node:crypto'
import { MeridianDb } from './meridian-db.js'
import { MeridianBehavior } from './meridian-behavior.js'
import { parseFile, parseTypeScriptFile, initParser, detectLang } from './meridian-parser.js'
import { buildRepoMap } from './meridian-graph.js'
import { analyzeImpact, inferTestedByTargets } from './meridian-impact.js'
import type { RepoMapResult } from './meridian-types.js'
import type { RepoMapOptions } from './meridian-graph.js'
import type { ImpactResult } from './meridian-impact.js'
import type { StigmergyStore } from '../context/stigmergy.js'
import { classifyPath } from '../context/attention-filter.js'

const TS_EXTENSIONS = ['.ts', '.tsx', '.js', '.jsx']
const ALL_EXTENSIONS = ['.ts', '.tsx', '.js', '.jsx', '.py', '.go']
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

  getDb(): MeridianDb { return this.db }

  private async ensureInit(): Promise<void> {
    if (!this.initialized) {
      await initParser()
      this.initialized = true
    }
  }

  async indexFile(filePath: string): Promise<void> {
    const rel = this.toRepoRelative(filePath)
    if (rel === null) return
    if (this.indexing.has(rel)) return
    if (!this.isIndexable(rel)) return

    const absPath = resolve(this.cwd, rel)
    if (!existsSync(absPath)) return

    const source = readFileSync(absPath, 'utf-8')
    const hash = createHash('sha256').update(source).digest('hex').slice(0, 16)

    if (!this.db.needsParse(rel, hash)) {
      this.db.recordAccess(rel)
      return
    }

    await this.ensureInit()
    this.indexing.add(rel)

    try {
      const result = await parseFile(rel, source)
      this.db.upsertFile(result)
      this.db.recordAccess(rel)

      // Build tested_by edges if this is a test file
      if (this.isTestFile(rel)) {
        this.buildTestEdges(rel)
      }

      // 1-hop expand: parse direct imports
      for (const imp of result.imports) {
        const resolved = this.resolveImport(rel, imp)
        if (resolved && !this.indexing.has(resolved)) {
          await this.indexFile(resolved)
        }
      }
    } finally {
      this.indexing.delete(rel)
    }
  }

  async invalidateFile(filePath: string): Promise<void> {
    const rel = this.toRepoRelative(filePath)
    if (rel === null) return
    if (!this.isIndexable(rel)) return
    const absPath = resolve(this.cwd, rel)
    if (!existsSync(absPath)) return

    await this.ensureInit()
    const source = readFileSync(absPath, 'utf-8')
    const result = await parseFile(rel, source)
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
    const rel = this.toRepoRelative(filePath)
    if (rel === null) return
    this.behavior.recordEdit(rel, turn)
  }

  flushTurn(): void {
    this.behavior.flushCoEdits()
  }

  /** Analyze impact radius for changed files */
  impact(changedFiles: string[], opts?: { maxHops?: number }): ImpactResult {
    return analyzeImpact(this.db, changedFiles, opts)
  }

  /** Build tested_by edges for a test file based on naming + imports */
  buildTestEdges(testFilePath: string): void {
    const allFiles = this.db.getAllFiles()
    const targets = inferTestedByTargets(testFilePath, allFiles)
    for (const target of targets) {
      const sourceId = `${testFilePath}:*:0`
      const targetId = `${target}:*:0`
      this.db.upsertEdge(sourceId, targetId, 'tested_by', 0.7, 'inferred')
    }
  }

  getStats() {
    return this.db.getStats()
  }

  close(): void {
    this.db.close()
  }

  /** Normalize to repo-relative path for classification & DB keys.
   *  Returns null for any path that resolves outside the repo root —
   *  covers both absolute paths and relative `../` traversal.
   *  Fail-closed: the indexer must never read/parse/store files
   *  outside the project boundary. */
  private toRepoRelative(filePath: string): string | null {
    const absCwd = resolve(this.cwd)
    const absFile = resolve(this.cwd, filePath)
    if (!absFile.startsWith(absCwd + '/')) return null
    return absFile.slice(absCwd.length + 1)
  }

  private isIndexable(filePath: string): boolean {
    const rel = this.toRepoRelative(filePath)
    if (rel === null) return false
    if (IGNORE_PATTERNS.some(p => rel.includes(p))) return false
    if (classifyPath(rel).silent) return false
    return ALL_EXTENSIONS.some(ext => rel.endsWith(ext))
  }

  private isTestFile(filePath: string): boolean {
    return filePath.includes('.test.') || filePath.includes('.spec.') ||
      filePath.includes('__tests__/') || filePath.includes('test/')
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
