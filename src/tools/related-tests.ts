import { stat } from 'node:fs/promises'
import { join, dirname, basename, extname } from 'path'
import { isAbsolute } from 'node:path'
import type { Tool, ToolCallParams } from './types.js'
import type { MeridianIndexer } from '../repo/meridian-indexer.js'
import { analyzeImpact } from '../repo/meridian-impact.js'

async function fileExists(path: string): Promise<boolean> {
  try { await stat(path); return true } catch { return false }
}

function isTestFile(filePath: string): boolean {
  const base = basename(filePath)
  return base.includes('.test.') || base.includes('.spec.')
}

async function findTestsForSource(file: string, cwd: string): Promise<string[]> {
  const parsed = extname(file)
  const ext = parsed
  const baseName = basename(file, ext)
  const dir = dirname(file)
  const parentDir = dirname(dir)

  // Strip src/ prefix for some candidate patterns
  const relDir = dir.startsWith('src/') ? dir.slice(4) : dir

  const candidates = [
    // __tests__ dir colocated
    join(dir, '__tests__', `${baseName}.test.ts`),
    join(dir, '__tests__', `${baseName}.spec.ts`),
    // Parent __tests__ dir
    join(parentDir, '__tests__', `${baseName}.test.ts`),
    join(parentDir, '__tests__', `${baseName}.spec.ts`),
    // Co-located test file
    join(dir, `${baseName}.test.ts`),
    join(dir, `${baseName}.spec.ts`),
    // Top-level __tests__ mirroring src path
    join('__tests__', relDir, `${baseName}.test.ts`),
    join('__tests__', relDir, `${baseName}.spec.ts`),
    // Top-level tests dir mirroring src path
    join('tests', relDir, `${baseName}.test.ts`),
    join('tests', relDir, `${baseName}.spec.ts`),
  ]

  const withExists = await Promise.all(
    candidates.map(async (c) => ({ path: c, exists: await fileExists(join(cwd, c)) })),
  )
  return withExists.filter(c => c.exists).map(c => c.path).sort()
}

async function findSourceForTest(file: string, cwd: string): Promise<string[]> {
  const parsed = extname(file)
  const ext = parsed
  // Strip test indicators: .test.ts -> .ts, .spec.ts -> .ts
  const baseName = basename(file, ext).replace(/\.test$|\.spec$/, '') + ext
  const dir = dirname(file)

  // Map test dir patterns back to source dirs
  const sourceDirs: string[] = []

  // __tests__/foo.test.ts -> same parent dir
  if (basename(dir) === '__tests__') {
    sourceDirs.push(dirname(dir))
  }

  // tests/tools/foo.test.ts -> src/tools/
  if (dir.startsWith('tests/')) {
    sourceDirs.push(join('src', dir.slice(6)))
  }

  // __tests__/tools/foo.test.ts -> src/tools/
  if (dir.startsWith('__tests__/')) {
    sourceDirs.push(join('src', dir.slice(10)))
  }

  // Co-located: same dir
  sourceDirs.push(dir)

  const candidates = sourceDirs.map((d) => join(d, baseName))
  const withExists = await Promise.all(
    candidates.map(async (c) => ({ path: c, exists: await fileExists(join(cwd, c)) })),
  )
  return withExists.filter(c => c.exists).map(c => c.path).sort()
}

const DEFINITION = {
  name: 'related_tests' as const,
  description: `Find test files related to a given source file.

### Usage
- Use after editing a source file to find which tests to run
- Use before editing to understand what tests exist for a file
- Returns list of matching test file paths

### Examples
Good: related_tests(file="src/tools/bash.ts") — find tests for bash tool
Good: related_tests(file="src/api/client.ts") — find tests for API client`,
  input_schema: {
    type: 'object' as const,
    properties: {
      file: { type: 'string', description: 'Source file path relative to cwd' },
    },
    required: ['file'],
  },
}

/**
 * Factory: creates a related_tests tool that prefers meridian SQL when an
 * indexer is available, falling back to hardcoded path heuristics otherwise.
 * Mirrors the createRepoGraphTool DI pattern.
 */
export function createRelatedTestsTool(
  getIndexer: () => MeridianIndexer | null | undefined,
): Tool {
  return {
    definition: DEFINITION,

    async execute(params: ToolCallParams) {
      let file = params.input.file as string

      // Reject absolute paths (incl. Windows `C:\`) — only relative paths within cwd allowed
      if (isAbsolute(file) || file.includes('..')) {
        return { content: 'Error: file path must be relative to project directory.', isError: true }
      }

      if (isTestFile(file)) {
        const sources = await findSourceForTest(file, params.cwd)
        if (sources.length === 0) {
          return { content: 'No related source files found.' }
        }
        return { content: sources.join('\n') }
      }

      // Prefer meridian SQL (real import graph) over hardcoded path heuristics.
      const db = getIndexer()?.getDb()
      if (db && !isAbsolute(file)) {
        const testedBy = db.getTestsFor(file)
        const impact = analyzeImpact(db, [file])
        const allTests = [...new Set([...testedBy, ...impact.tests])]
        if (allTests.length > 0) {
          return { content: allTests.sort().join('\n') }
        }
      }

      // Fallback: hardcoded path heuristics
      const tests = await findTestsForSource(file, params.cwd)
      if (tests.length === 0) {
        return { content: 'No related tests found.' }
      }
      return { content: tests.join('\n') }
    },

    requiresApproval: () => false,
    isConcurrencySafe: () => true,
    isEnabled: () => true,
  }
}

/** Backward-compatible static tool — no indexer, always uses hardcoded heuristics. */
export const RELATED_TESTS_TOOL: Tool = createRelatedTestsTool(() => null)
