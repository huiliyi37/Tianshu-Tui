/**
 * Codebase Index — Project Perception Layer
 *
 * Provides a structured, incrementally-maintained index of module responsibilities,
 * CLI entry points, and exported symbols. Injected into agent volatile context so
 * the agent enters each session with project knowledge, eliminating redundant grep
 * exploration.
 *
 * Design principles (from plan docs/superpowers/plans/2026-06-07-project-perception-codebase-wiki.md):
 * - A-class facts (per-file, independent): stored in MeridianDB, incrementally updated
 * - B-class facts (cross-file aggregates): computed at injection time, never persisted
 * - Every persisted fact carries verifiedAtCommit for staleness detection
 * - Index is generated from DB on demand — no shared flat files
 */

import { readdirSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { execSync } from 'node:child_process'
import type { MeridianDb } from './meridian-db.js'
import type { ModuleSummaryEntry, CliEntry } from './meridian-types.js'

// ─── Public types ────────────────────────────────────────────────

export type ProjectState = 'empty' | 'cold' | 'indexed'

export interface CodebaseIndexSnapshot {
  modules: ModuleSummaryEntry[]
  cliEntries: CliEntry[]
  dbStats: { files: number; symbols: number; edges: number }
}

// ─── Project state detection ─────────────────────────────────────

/**
 * Detect the project's indexing state.
 * - empty: no source files (or empty directory)
 * - cold: has source files but no module_summaries in DB
 * - indexed: module_summaries exist
 */
export function detectProjectState(cwd: string, db: MeridianDb): ProjectState {
  const summaries = db.getModuleSummaries()
  if (summaries.length > 0) return 'indexed'

  // Check if there are any source files at all
  try {
    const entries = readdirSync(cwd).filter(e => !e.startsWith('.'))
    if (entries.length === 0) return 'empty'
  } catch {
    return 'empty'
  }

  // Has files, but no index
  const stats = db.getStats()
  if (stats.files === 0) return 'empty'

  return 'cold'
}

// ─── Directory-based module discovery ────────────────────────────

export interface DiscoveredModule {
  dirPath: string
  files: string[]
  exportedSymbols: Array<{ name: string; kind: string }>
}

/**
 * Group indexed files by their top-level directory under src/,
 * collecting exported symbols for each group.
 */
export function discoverModules(db: MeridianDb): DiscoveredModule[] {
  const allFiles = db.getAllFiles()
  const dirMap = new Map<string, { files: string[]; exports: Map<string, string> }>()

  for (const file of allFiles) {
    // Skip test files and non-src files
    if (file.includes('__tests__') || file.includes('.test.') || file.includes('.spec.')) continue

    const parts = file.split('/')
    if (parts.length < 2) continue
    // Group by first two path segments: src/agent/ or src/tools/
    const dir = parts.length >= 3 ? parts.slice(0, 2).join('/') + '/' : parts[0] + '/'

    if (!dirMap.has(dir)) {
      dirMap.set(dir, { files: [], exports: new Map() })
    }
    const entry = dirMap.get(dir)!
    entry.files.push(file)

    // Collect exported symbols — de-duplicate by name, keep first seen kind
    const symbols = db.getSymbolsForFile(file)
    for (const sym of symbols) {
      if (sym.exported && !entry.exports.has(sym.name)) {
        entry.exports.set(sym.name, sym.kind)
      }
    }
  }

  return Array.from(dirMap.entries())
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([dirPath, data]) => ({
      dirPath,
      files: data.files,
      exportedSymbols: Array.from(data.exports.entries()).map(([name, kind]) => ({ name, kind })),
    }))
}

// ─── Module summary seeding (static, no LLM) ────────────────────

/**
 * Known module summaries from AGENTS.md architecture map.
 * Used for static seeding when no LLM is available.
 * These are only defaults — the DB entries will carry verifiedAtCommit
 * and can be overwritten by LLM-generated summaries via /index.
 */
export const KNOWN_MODULE_SUMMARIES: Record<string, string> = {
  'src/agent/': '核心智能体循环、工具流水线、多模型协调、压缩、子智能体、验证、交付门禁',
  'src/tools/': '工具实现（definition + execute）与注册',
  'src/api/': 'API 客户端层（OpenAI 兼容、Codex OAuth、流式处理）',
  'src/prompt/': '系统提示词工程（static / volatile / engine）',
  'src/tui/': '终端 UI（Ink 6 / React）',
  'src/compact/': '上下文压缩策略（修剪、微压缩、阈值）',
  'src/cache/': '前缀缓存管理与命中诊断',
  'src/repo/': '代码仓库分析（导入图、持久化索引）',
  'src/config/': '配置管理（默认 → ~/.rivet → 项目多层加载）',
  'src/artifact/': '大输出持久化',
  'src/context/': '上下文管理（claims、rules、project memory）',
  'src/plan/': '实现计划存储与审批',
  'src/mcp/': 'MCP (Model Context Protocol) 服务器管理',
  'src/workflows/': '生态系统工作流',
  'src/commands/': '自定义命令加载器',
}

/**
 * Seed module summaries from existing DB data.
 * Uses known descriptions from AGENTS.md for recognized directories,
 * falls back to top exported symbols for unknown modules.
 *
 * Returns the number of modules seeded.
 */
export function seedModuleSummaries(db: MeridianDb, headSha?: string): number {
  const modules = discoverModules(db)
  if (modules.length === 0) return 0

  const commit = headSha ?? getHeadSha()
  let seeded = 0

  for (const mod of modules) {
    const summary = KNOWN_MODULE_SUMMARIES[mod.dirPath]
      ?? `module (${mod.exportedSymbols.slice(0, 3).map(s => s.name).join(', ')})`

    db.upsertModuleSummary({
      dirPath: mod.dirPath,
      summary,
      keyExports: mod.exportedSymbols.slice(0, 10).map(s => s.name),
      fileCount: mod.files.length,
      status: 'active',
      contentHash: '',
      verifiedAtCommit: commit,
    })
    seeded++
  }

  return seeded
}

// ─── CLI entry extraction (static analysis) ──────────────────────

/**
 * Extract CLI flag entries from main.tsx and headless.ts by scanning
 * for common patterns: args[0] ===, args.includes, args.indexOf.
 *
 * This is a pragmatic static extractor — not a full AST walk.
 * The plan notes 4 heterogeneous patterns in main.tsx alone;
 * this covers the most common ones.
 */
export function extractCliEntries(
  mainTsxSource: string,
  headlessSource: string | null,
  mainTsxPath: string,
  headlessPath: string,
  headSha?: string,
): CliEntry[] {
  const entries: CliEntry[] = []
  const commit = headSha ?? getHeadSha()

  // Pattern 1: args[0] === 'serve' / args[0] === '--help' etc.
  const args0Re = /args\[0\]\s*===\s*['"]([^'"]+)['"]/g
  let match: RegExpExecArray | null
  while ((match = args0Re.exec(mainTsxSource)) !== null) {
    const flag = match[1] ?? ''
    const line = lineNumberAt(mainTsxSource, match.index ?? 0)
    entries.push({
      flag,
      handler: `${mainTsxPath}:${line}`,
      wired: true,
      verifiedAtCommit: commit,
      sourceFile: mainTsxPath,
    })
  }

  // Pattern 2: args.includes('--goal') / args.includes('-p')
  const includesRe = /args\.includes\(\s*['"](-[^'"]+)['"]\s*\)/g
  while ((match = includesRe.exec(mainTsxSource)) !== null) {
    const flag = match[1] ?? ''
    const line = lineNumberAt(mainTsxSource, match.index ?? 0)
    entries.push({
      flag,
      handler: `${mainTsxPath}:${line}`,
      wired: true,
      verifiedAtCommit: commit,
      sourceFile: mainTsxPath,
    })
  }

  // Pattern 3: args.indexOf('--port') / args.indexOf('--provider')
  const indexOfRe = /args\.indexOf\(\s*['"](-[^'"]+)['"]\s*\)/g
  while ((match = indexOfRe.exec(mainTsxSource)) !== null) {
    const flag = match[1] ?? ''
    const line = lineNumberAt(mainTsxSource, match.index ?? 0)
    entries.push({
      flag,
      handler: `${mainTsxPath}:${line}`,
      wired: true,
      verifiedAtCommit: commit,
      sourceFile: mainTsxPath,
    })
  }

  // Pattern 4: headless.ts findIndex patterns
  if (headlessSource) {
    const headlessFlags = ['--json', '--stream-json', '--print', '-p', '--goal', '-g']
    for (const flag of headlessFlags) {
      if (headlessSource.includes(`'${flag}'`) || headlessSource.includes(`"${flag}"`)) {
        const idx = headlessSource.indexOf(`'${flag}'`) !== -1
          ? headlessSource.indexOf(`'${flag}'`)
          : headlessSource.indexOf(`"${flag}"`)
        const line = lineNumberAt(headlessSource, idx)
        entries.push({
          flag,
          handler: `${headlessPath}:${line}`,
          wired: true,
          verifiedAtCommit: commit,
          sourceFile: headlessPath,
        })
      }
    }
  }

  return entries
}

// ─── Index generation for volatile context injection ─────────────

/**
 * Generate a compact codebase-index block for volatile context.
 * Designed to fit within ~500 tokens, covering module summaries
 * and CLI entry status.
 *
 * Staleness: if headSha differs from a fact's verifiedAtCommit,
 * mark it ⚠stale to prompt the agent to re-verify.
 */
export function generateCodebaseIndexBlock(
  db: MeridianDb,
  headSha?: string | null,
): string {
  const modules = db.getModuleSummaries()
  const cliEntries = db.getCliEntries()
  const stats = db.getStats()

  if (modules.length === 0 && cliEntries.length === 0 && stats.files === 0) return ''

  const sha = headSha ?? null
  const parts: string[] = []

  parts.push('<codebase-index>')
  parts.push(`Codebase: ${stats.files} files, ${stats.symbols} symbols, ${stats.edges} edges`)

  // Module summaries — compact table format
  if (modules.length > 0) {
    parts.push('')
    parts.push('Modules:')
    for (const m of modules) {
      const stale = sha && m.verifiedAtCommit && sha !== m.verifiedAtCommit ? ' ⚠stale' : ''
      const exports = m.keyExports.length > 0 ? ` → ${m.keyExports.slice(0, 5).join(', ')}` : ''
      parts.push(`  ${m.dirPath} ${m.summary}${exports}${stale}`)
    }
  }

  // CLI entries — compact
  if (cliEntries.length > 0) {
    parts.push('')
    parts.push('CLI:')
    for (const e of cliEntries) {
      const stale = sha && e.verifiedAtCommit && sha !== e.verifiedAtCommit ? ' ⚠stale' : ''
      parts.push(`  ${e.flag} → ${e.handler} ✅${stale}`)
    }
  }

  parts.push('</codebase-index>')
  return parts.join('\n')
}

// ─── Full rebuild (for /index command) ───────────────────────────

/**
 * Perform a full index rebuild:
 * 1. Discover modules from MeridianDB
 * 2. Seed module summaries (static)
 * 3. Extract CLI entries
 * 4. Store everything in DB
 *
 * Returns a summary string for the user.
 */
export function fullRebuild(
  db: MeridianDb,
  mainTsxSource: string,
  headlessSource: string | null,
  mainTsxPath: string,
  headlessPath: string,
): string {
  const headSha = getHeadSha()

  // Seed module summaries
  const moduleCount = seedModuleSummaries(db, headSha)

  // Clear and re-extract CLI entries
  // (We re-insert all, upsert handles dedup via PK)
  const cliEntries = extractCliEntries(mainTsxSource, headlessSource, mainTsxPath, headlessPath, headSha)
  for (const entry of cliEntries) {
    db.upsertCliEntry(entry)
  }

  const stats = db.getStats()
  return `Index rebuilt: ${moduleCount} modules, ${cliEntries.length} CLI entries (${stats.files} files, ${stats.symbols} symbols indexed)`
}

// ─── Helpers ─────────────────────────────────────────────────────

/** Get current HEAD SHA, or undefined if not in a git repo */
export function getHeadSha(): string {
  try {
    return execSync('git rev-parse --short HEAD', { encoding: 'utf-8', timeout: 3000 }).trim()
  } catch {
    return ''
  }
}

/** Compute 1-based line number from character offset */
function lineNumberAt(source: string, offset: number): number {
  let line = 1
  for (let i = 0; i < offset && i < source.length; i++) {
    if (source[i] === '\n') line++
  }
  return line
}
