import { readdirSync } from 'fs'
import { resolve, join, relative } from 'path'
import type { Tool, ToolCallParams, ToolResult } from './types.js'
import { GitignoreFilter } from './gitignore.js'

const MAX_RESULTS = 500

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
        pattern: { type: 'string', description: 'Glob pattern e.g. "src/**/*.ts" or "*.md"' },
        path: { type: 'string', description: 'Search root directory (default: cwd)' },
      },
      required: ['pattern'],
    },
  },

  async execute(params: ToolCallParams): Promise<ToolResult> {
    const pattern = params.input.pattern as string
    const searchRoot = (params.input.path as string) ?? '.'

    const absRoot = resolve(params.cwd, searchRoot)
    const filter = new GitignoreFilter(params.cwd)

    try {
      const results = walkGlob(absRoot, pattern, params.cwd, filter)
      if (results.length === 0) {
        return { content: 'No files found.' }
      }
      return { content: results.slice(0, MAX_RESULTS).join('\n') }
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err)
      return { content: `Error: ${message}`, isError: true }
    }
  },

  requiresApproval: () => false,
  isConcurrencySafe: () => true,
  isEnabled: () => true,
}

function compilePattern(pattern: string): { parts: string[]; isAbsolute: boolean } {
  const isAbsolute = pattern.startsWith('/')
  const parts = pattern.replace(/\/+/g, '/').split('/')
  return { parts, isAbsolute }
}

function matchSegment(segment: string, name: string): boolean {
  if (segment === '**') return true
  // Handle brace expansion: {a,b}
  if (segment.includes('{') && segment.includes('}')) {
    const braceRe = /^(.*)\{([^}]+)\}(.*)$/
    const m = segment.match(braceRe)
    if (m) {
      const [, prefix, group, suffix] = m
      const options = group!.split(',')
      return options.some(o => matchSegment(`${prefix}${o}${suffix ?? ''}`, name))
    }
  }
  // Convert glob to regex
  const reStr = segment
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replace(/\*/g, '[^/]*')
    .replace(/\?/g, '[^/]')
  return new RegExp(`^${reStr}$`).test(name)
}

function walkGlob(root: string, pattern: string, cwd: string, filter: GitignoreFilter): string[] {
  const { parts } = compilePattern(pattern)
  const results: string[] = []

  function walk(dir: string, partIdx: number) {
    if (results.length >= MAX_RESULTS) return

    if (partIdx >= parts.length) {
      results.push(relative(cwd, dir))
      return
    }

    const segment = parts[partIdx]!

    if (segment === '**') {
      // ** matches zero or more directories
      // Option 1: zero directories — skip to next part
      walk(dir, partIdx + 1)
      // Option 2: one or more directories — descend
      try {
        const entries = readdirSync(dir, { withFileTypes: true })
        for (const entry of entries) {
          const full = join(dir, entry.name)
          if (entry.isDirectory()) {
            if (!filter.isIgnored(cwd, full)) {
              walk(full, partIdx)       // continue **
              walk(full, partIdx + 1)   // or stop ** here
            }
          } else if (entry.isFile()) {
            // ** can also match files directly
            walk(full, partIdx + 1)
          }
        }
      } catch { /* skip unreadable */ }
      return
    }

    // Regular segment: match current directory entries
    try {
      const entries = readdirSync(dir, { withFileTypes: true })
      for (const entry of entries) {
        const full = join(dir, entry.name)
        if (filter.isIgnored(cwd, full)) continue

        if (matchSegment(segment, entry.name)) {
          if (partIdx === parts.length - 1) {
            // Last segment: add files and dirs that match
            if (entry.isFile()) {
              results.push(relative(cwd, full))
            }
            // For last segment matching a directory, also include it
            // (user asked for "src/components" etc.)
          } else {
            // Not last segment: must be directory to descend
            if (entry.isDirectory()) {
              walk(full, partIdx + 1)
            }
          }
        }
      }
    } catch { /* skip unreadable */ }
  }

  walk(root, 0)
  results.sort()
  return results
}
