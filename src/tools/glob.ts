import { readdir, lstat, realpath, stat } from 'node:fs/promises'
import { join } from 'path'
import type { Tool, ToolCallParams } from './types.js'
import { validatePathSafe } from './path-validate.js'
import { relativePosix } from '../path-format.js'
import { GitignoreFilter } from './gitignore.js'
import { classifyPath } from '../context/attention-filter.js'
import { isRestrictedPath } from '../platform/restricted-paths.js'

const EXCLUDE_DIRS = new Set([
  'node_modules', '.git', 'dist', '.next', 'build', 'target', '__pycache__',
])
const MAX_RESULTS = 500

function escapeRegex(str: string): string {
  return str.replace(/[.+^$()|[\]\\{}]/g, '\\$&')
}

function globPatternExplicitlyTargetsSilentLayer(pattern: string, requestedRoot: string): boolean {
  if (classifyPath(pattern).silent) return true
  const normalized = `${requestedRoot}/${pattern}`.replaceAll('\\', '/').replace(/\/+/g, '/')
  const literalPrefix = normalized.split(/[*?{]/, 1)[0] ?? ''
  const trimmed = literalPrefix.replace(/^\.\//, '').replace(/\/$/, '')
  if (!trimmed) return false
  return classifyPath(trimmed).silent
}

function globToRegex(pattern: string): RegExp {
  let regex = ''
  let i = 0
  while (i < pattern.length) {
    const ch = pattern[i]!
    if (ch === '*' && pattern[i + 1] === '*') {
      regex += '.*'
      i += 2
      if (pattern[i] === '/') i++
    } else if (ch === '*') {
      regex += '[^/]*'
      i++
    } else if (ch === '?') {
      regex += '[^/]'
      i++
    } else if (ch === '{') {
      const end = pattern.indexOf('}', i)
      if (end === -1) {
        regex += '\\{'
        i++
      } else {
        const alternatives = pattern
          .slice(i + 1, end)
          .split(',')
          .map((a) => escapeRegex(a.trim()))
          .join('|')
        regex += `(?:${alternatives})`
        i = end + 1
      }
    } else if ('.+^$()|[]\\{}'.includes(ch)) {
      regex += '\\' + ch
      i++
    } else {
      regex += ch
      i++
    }
  }
  return new RegExp(`^${regex}$`)
}

async function walkDir(
  dir: string,
  results: string[],
  root: string,
  filter: RegExp | undefined,
  includeSilentMatches: boolean,
  visited = new Set<string>(),
): Promise<void> {
  if (results.length >= MAX_RESULTS) return

  let real: string
  try {
    real = await realpath(dir)
  } catch {
    return
  }
  if (visited.has(real)) return
  visited.add(real)

  let names: string[]
  try {
    names = await readdir(dir)
  } catch (err) {
    const e = err as NodeJS.ErrnoException
    // Root path restricted → propagate (agent needs "target unreachable" not empty result).
    // Non-root + restricted system path + permission error → silent skip.
    // Other errors on subdirs → silent skip (preserves existing catch-all behavior).
    if (dir === root || !isRestrictedPath(String(e.path ?? e.message ?? ''), e.code ?? '')) {
      if (dir === root) throw err
      return
    }
    return
  }

  for (const name of names) {
    if (results.length >= MAX_RESULTS) return
    const fullPath = join(dir, name)
    let s: Awaited<ReturnType<typeof lstat>>
    try {
      s = await lstat(fullPath)
    } catch {
      continue
    }

    if (s.isSymbolicLink()) continue
    const rel = relativePosix(root, fullPath)
    const verdict = classifyPath(rel)
    if (s.isDirectory()) {
      if (EXCLUDE_DIRS.has(name)) continue
      if (verdict.tier === 'L0_build') continue
      await walkDir(fullPath, results, root, filter, includeSilentMatches, visited)
    } else if (s.isFile()) {
      if ((!verdict.silent || includeSilentMatches) && (!filter || filter.test(rel))) {
        results.push(rel)
      }
    }
  }
}

export const GLOB_TOOL: Tool = {
  definition: {
    name: 'glob',
    description: `Find files matching a glob pattern.

### Usage
- Use glob to locate files by name or pattern before reading them
- Supports ** for recursive directory matching
- Supports * wildcard, ? single-char, {a,b} alternation
- Results are sorted and limited to 500

### Examples
Good: glob(pattern="src/**/*.ts")
Good: glob(pattern="*.test.ts", path="src/")
Good: glob(pattern="src/components/**/*.tsx")
Bad: glob(pattern="node_modules/**") (excluded by default)`,
    input_schema: {
      type: 'object',
      properties: {
        pattern: {
          type: 'string',
          description: 'Glob pattern e.g. "src/**/*.ts" or "*.md"',
        },
        path: {
          type: 'string',
          description: 'Search root directory (default: cwd)',
        },
      },
      required: ['pattern'],
    },
  },

  async execute(params: ToolCallParams) {
    const pattern = params.input.pattern as string
    const requestedRoot = params.input.path ? String(params.input.path) : '.'
    const validated = validatePathSafe(params.cwd, requestedRoot)
    if (!validated.ok) {
      return { content: `Error: ${validated.error}`, isError: true }
    }
    const searchRoot = validated.path

    let s: Awaited<ReturnType<typeof stat>>
    try {
      s = await stat(searchRoot)
    } catch {
      return { content: `Error: Directory not found: ${searchRoot}`, isError: true }
    }
    if (!s.isDirectory()) {
      return { content: `Error: Not a directory: ${searchRoot}`, isError: true }
    }

    const regex = globToRegex(pattern)
    const gitignore = await GitignoreFilter.create(params.cwd)
    const includeSilentMatches = globPatternExplicitlyTargetsSilentLayer(pattern, requestedRoot)
    const files: string[] = []
    try {
      await walkDir(searchRoot, files, searchRoot, regex, includeSilentMatches)
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      return { content: `Error: ${message}`, isError: true }
    }

    const matches = files
      .filter(f => !gitignore.isIgnored(params.cwd, join(searchRoot, f)))
      .sort()
      .map((f) => relativePosix(params.cwd, join(searchRoot, f)))

    return {
      content: matches.length > 0 ? matches.join('\n') : 'No files found matching pattern',
    }
  },

  requiresApproval: () => false,
  isConcurrencySafe: () => true,
  isEnabled: () => true,
}
