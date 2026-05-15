import { readdirSync, existsSync, lstatSync, realpathSync } from 'fs'
import { join, relative } from 'path'
import type { Tool, ToolCallParams } from './types.js'
import { validatePathSafe } from './path-validate.js'
import { GitignoreFilter } from './gitignore.js'

const EXCLUDE_DIRS = new Set([
  'node_modules', '.git', 'dist', '.next', 'build', 'target', '__pycache__',
])
const MAX_RESULTS = 500

function escapeRegex(str: string): string {
  return str.replace(/[.+^$()|[\]\\{}]/g, '\\$&')
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

function walkDir(
  dir: string,
  results: string[],
  root: string,
  filter: RegExp | undefined,
  visited = new Set<string>(),
): void {
  if (results.length >= MAX_RESULTS) return

  let real: string
  try {
    real = realpathSync(dir)
  } catch {
    return
  }
  if (visited.has(real)) return
  visited.add(real)

  let names: string[]
  try {
    names = readdirSync(dir)
  } catch {
    return
  }

  for (const name of names) {
    if (results.length >= MAX_RESULTS) return
    const fullPath = join(dir, name)
    let s: ReturnType<typeof lstatSync>
    try {
      s = lstatSync(fullPath)
    } catch {
      continue
    }

    if (s.isSymbolicLink()) continue
    if (s.isDirectory()) {
      if (EXCLUDE_DIRS.has(name)) continue
      walkDir(fullPath, results, root, filter, visited)
    } else if (s.isFile()) {
      const rel = relative(root, fullPath)
      if (!filter || filter.test(rel)) {
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

    if (!existsSync(searchRoot)) {
      return { content: `Error: Directory not found: ${searchRoot}`, isError: true }
    }
    try {
      const stat = lstatSync(searchRoot)
      if (!stat.isDirectory()) {
        return { content: `Error: Not a directory: ${searchRoot}`, isError: true }
      }
    } catch {
      return { content: `Error: Cannot access path: ${searchRoot}`, isError: true }
    }

    const regex = globToRegex(pattern)
    const gitignore = new GitignoreFilter(params.cwd)
    const files: string[] = []
    walkDir(searchRoot, files, searchRoot, regex)

    const matches = files
      .filter(f => !gitignore.isIgnored(params.cwd, join(searchRoot, f)))
      .sort()
      .map((f) => relative(params.cwd, join(searchRoot, f)))

    return {
      content: matches.length > 0 ? matches.join('\n') : 'No files found matching pattern',
    }
  },

  requiresApproval: () => false,
  isConcurrencySafe: () => true,
  isEnabled: () => true,
}
