import { readdirSync, existsSync, statSync } from 'fs'
import { join, resolve, relative } from 'path'
import type { Tool, ToolCallParams } from './types.js'

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

function walkDir(dir: string, results: string[], root: string): void {
  if (results.length >= MAX_RESULTS) return
  let names: string[]
  try {
    names = readdirSync(dir)
  } catch {
    return
  }
  for (const name of names) {
    if (results.length >= MAX_RESULTS) return
    const fullPath = join(dir, name)
    let s: ReturnType<typeof statSync>
    try {
      s = statSync(fullPath)
    } catch {
      continue
    }
    if (s.isDirectory()) {
      if (EXCLUDE_DIRS.has(name)) continue
      walkDir(fullPath, results, root)
    } else if (s.isFile()) {
      results.push(relative(root, fullPath))
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
    const searchRoot = params.input.path
      ? resolve(params.cwd, params.input.path as string)
      : params.cwd

    if (!existsSync(searchRoot)) {
      return { content: `Error: Directory not found: ${searchRoot}`, isError: true }
    }
    try {
      const stat = statSync(searchRoot)
      if (!stat.isDirectory()) {
        return { content: `Error: Not a directory: ${searchRoot}`, isError: true }
      }
    } catch {
      return { content: `Error: Cannot access path: ${searchRoot}`, isError: true }
    }

    const regex = globToRegex(pattern)
    const files: string[] = []
    walkDir(searchRoot, files, searchRoot)

    const matches = files
      .filter((f) => regex.test(f))
      .sort()
      .map((f) => {
        const absPath = join(searchRoot, f)
        return relative(params.cwd, absPath)
      })

    return {
      content: matches.length > 0 ? matches.join('\n') : 'No files found matching pattern',
    }
  },

  requiresApproval: () => false,
  isConcurrencySafe: () => true,
  isEnabled: () => true,
}
