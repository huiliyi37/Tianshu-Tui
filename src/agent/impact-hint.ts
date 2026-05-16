import type { ImportGraph } from './import-graph.js'
import { getReverseDeps } from './import-graph.js'
import { existsSync } from 'fs'
import { join, dirname, basename, extname, isAbsolute, relative } from 'path'

export interface ImpactHint {
  changedFile: string
  impactedFiles: string[]
  relatedTests: string[]
  summary: string
}

function isTestFile(filePath: string): boolean {
  const base = basename(filePath)
  return base.includes('.test.') || base.includes('.spec.')
}

function findTestsForSource(file: string, cwd: string): string[] {
  const ext = extname(file)
  const baseName = basename(file, ext)
  const dir = dirname(file)
  const parentDir = dirname(dir)
  const relDir = isAbsolute(dir) ? relative(cwd, dir) : dir
  const relDirClean = relDir.startsWith('src/') ? relDir.slice(4) : relDir

  const candidates = [
    join(dir, '__tests__', `${baseName}.test.ts`),
    join(dir, '__tests__', `${baseName}.spec.ts`),
    join(parentDir, '__tests__', `${baseName}.test.ts`),
    join(parentDir, '__tests__', `${baseName}.spec.ts`),
    join(dir, `${baseName}.test.ts`),
    join(dir, `${baseName}.spec.ts`),
    join('__tests__', relDirClean, `${baseName}.test.ts`),
    join('__tests__', relDirClean, `${baseName}.spec.ts`),
  ]

  return candidates
    .filter(c => isAbsolute(c) ? existsSync(c) : existsSync(join(cwd, c)))
    .sort()
}

export function generateImpactHint(
  graph: ImportGraph | null,
  changedFile: string,
  cwd: string,
): ImpactHint | null {
  if (!graph) return null

  const absFile = isAbsolute(changedFile) ? changedFile : join(cwd, changedFile)
  const impacted = getReverseDeps(graph, absFile)
  const impactedFiles = [...impacted].filter(f => !isTestFile(f))

  if (impactedFiles.length === 0) return null

  const allTests: string[] = []
  const seenTests = new Set<string>()

  // Tests for the changed file itself
  for (const t of findTestsForSource(changedFile, cwd)) {
    if (!seenTests.has(t)) {
      seenTests.add(t)
      allTests.push(t)
    }
  }

  // Tests for impacted files
  for (const f of impactedFiles) {
    for (const t of findTestsForSource(f, cwd)) {
      if (!seenTests.has(t)) {
        seenTests.add(t)
        allTests.push(t)
      }
    }
  }

  const fileNames = impactedFiles.map(f => basename(f))
  const summaryParts = [`Changed: ${basename(changedFile)}`]
  if (fileNames.length > 0) {
    summaryParts.push(`Impacts: ${fileNames.join(', ')}`)
  }
  if (allTests.length > 0) {
    summaryParts.push(`Tests: ${allTests.map(t => basename(t)).join(', ')}`)
  }

  return {
    changedFile,
    impactedFiles,
    relatedTests: allTests,
    summary: summaryParts.join(' → '),
  }
}
