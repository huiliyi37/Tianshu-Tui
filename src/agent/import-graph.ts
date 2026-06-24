/**
 * @deprecated 经络图（src/repo/meridian-*.ts）已提供持久化 SQLite 反向 BFS 影响分析。
 * 本模块保留仅供 fallback（tool-pipeline 无 meridianIndexer 时），计划在确认全量迁移后移除。
 */
import { readFileSync, existsSync, readdirSync, statSync } from 'fs'
import { join, resolve, dirname } from 'path'

export interface ImportGraph {
  forward: Map<string, Set<string>>
  reverse: Map<string, Set<string>>
}

const IMPORT_RE = /(?:import\s+.*?\s+from|require\s*\(\s*)\s*['"](\.\/[^'"]+|\.\\.[^'"]+)['"]/g
const MAX_FILES = 1000

function resolveImport(fromFile: string, importPath: string, cwd: string): string | null {
  const baseDir = dirname(fromFile)
  const absPath = resolve(cwd, baseDir, importPath)
  const extensions = ['', '.ts', '.tsx', '.js', '.jsx', '/index.ts', '/index.tsx', '/index.js']
  for (const ext of extensions) {
    const candidate = absPath + ext
    if (existsSync(candidate) && statSync(candidate).isFile()) return candidate
  }
  return null
}

function collectTsFiles(cwd: string): string[] {
  const files: string[] = []
  function walk(dir: string): void {
    if (files.length >= MAX_FILES) return
    const entries = readdirSync(dir, { withFileTypes: true })
    for (const entry of entries) {
      if (files.length >= MAX_FILES) return
      if (entry.name.startsWith('.') || entry.name === 'node_modules' || entry.name === 'dist') continue
      const full = join(dir, entry.name)
      if (entry.isDirectory()) {
        walk(full)
      } else if (/\.(ts|tsx)$/.test(entry.name) && !entry.name.endsWith('.d.ts')) {
        files.push(full)
      }
    }
  }
  walk(cwd)
  return files
}

export function buildImportGraph(cwd: string, maxFiles?: number): ImportGraph | null {
  const files = collectTsFiles(cwd)
  if (maxFiles !== undefined && files.length > maxFiles) return null
  if (files.length > MAX_FILES) return null

  const forward = new Map<string, Set<string>>()
  const reverse = new Map<string, Set<string>>()

  for (const file of files) {
    forward.set(file, new Set())
  }

  for (const file of files) {
    let content: string
    try {
      content = readFileSync(file, 'utf8')
    } catch {
      continue
    }

    const imports = new Set<string>()
    let match: RegExpExecArray | null
    const re = new RegExp(IMPORT_RE.source, IMPORT_RE.flags)
    while ((match = re.exec(content)) !== null) {
      const importPath = match[1]!
      const resolved = resolveImport(file, importPath, cwd)
      if (resolved && forward.has(resolved)) {
        imports.add(resolved)
      }
    }

    forward.set(file, imports)
    for (const imp of imports) {
      if (!reverse.has(imp)) reverse.set(imp, new Set())
      reverse.get(imp)!.add(file)
    }
  }

  return { forward, reverse }
}

export function getReverseDeps(graph: ImportGraph, file: string, cwd?: string): Set<string> {
  const absPath = file.startsWith('/') ? file : cwd ? resolve(cwd, file) : ''
  return absPath ? (graph.reverse.get(absPath) ?? new Set()) : new Set()
}

export function invalidateFile(graph: ImportGraph, cwd: string, file: string): ImportGraph {
  const absFile = file.startsWith('/') ? file : resolve(cwd, file)

  // Remove old forward edges for this file
  const oldImports = graph.forward.get(absFile) ?? new Set()
  for (const imp of oldImports) {
    const rev = graph.reverse.get(imp)
    if (rev) rev.delete(absFile)
  }

  // Re-scan this file
  let content: string
  try {
    content = readFileSync(absFile, 'utf8')
  } catch {
    graph.forward.delete(absFile)
    return graph
  }

  const newImports = new Set<string>()
  let match: RegExpExecArray | null
  const re = new RegExp(IMPORT_RE.source, IMPORT_RE.flags)
  while ((match = re.exec(content)) !== null) {
    const importPath = match[1]!
    const resolved = resolveImport(absFile, importPath, cwd)
    if (resolved && graph.forward.has(resolved)) {
      newImports.add(resolved)
    }
  }

  graph.forward.set(absFile, newImports)
  for (const imp of newImports) {
    if (!graph.reverse.has(imp)) graph.reverse.set(imp, new Set())
    graph.reverse.get(imp)!.add(absFile)
  }

  return graph
}
