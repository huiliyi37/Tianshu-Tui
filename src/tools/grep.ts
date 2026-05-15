import { spawn } from 'child_process'
import { createReadStream } from 'fs'
import { readdir, stat } from 'fs/promises'
import { resolve, join, relative } from 'path'
import { createInterface } from 'readline'
import type { Tool, ToolCallParams, ToolResult } from './types.js'
import { truncateContent } from './truncation.js'
import { GitignoreFilter } from './gitignore.js'

const MAX_RESULTS_DEFAULT = 100
const TIMEOUT_MS = 30_000

export const GREP_TOOL: Tool = {
  definition: {
    name: 'grep',
    description: `Search file contents with regex or literal patterns.

### Usage
- Use grep to find functions, classes, patterns, or keywords in source code
- Prefer grep over bash grep/rg — this tool is faster and respects .gitignore
- Results are grouped by file with line numbers
- Pattern can be a regex (default) or literal string

### Examples
Good: grep(pattern="function handleSubmit", path="src/")
Good: grep(pattern="API_KEY", path=".", glob="*.{ts,tsx}")
Bad: grep(pattern="x") (too broad — will match too many lines)`,
    input_schema: {
      type: 'object',
      properties: {
        pattern: { type: 'string', description: 'Regex or literal pattern to search for' },
        path: { type: 'string', description: 'Directory or file to search (default: cwd)' },
        glob: { type: 'string', description: 'File filter e.g. "*.ts" or "*.{ts,tsx}"' },
        max_results: { type: 'integer', description: 'Max matching lines (default: 100)' },
        literal: { type: 'boolean', description: 'Treat pattern as literal, not regex (default: false)' },
      },
      required: ['pattern'],
    },
  },

  async execute(params: ToolCallParams): Promise<ToolResult> {
    const pattern = params.input.pattern as string
    const searchPath = (params.input.path as string) ?? params.cwd
    const glob = params.input.glob as string | undefined
    const maxResults = (params.input.max_results as number) ?? MAX_RESULTS_DEFAULT
    const literal = (params.input.literal as boolean) ?? false

    const absPath = resolve(params.cwd, searchPath)

    // Try ripgrep first, fall back to native search
    const rgResult = await tryRipgrep(pattern, absPath, glob, maxResults, params.cwd, literal)
    if (rgResult !== null) return rgResult

    // Native fallback
    const regex = buildRegex(pattern, literal)
    if (!regex) {
      return { content: `Error: Invalid pattern: ${pattern}`, isError: true }
    }

    try {
      const results = await nativeSearch(absPath, regex, glob, maxResults, params.cwd)
      if (results.length === 0) {
        return { content: 'No matches found.' }
      }
      const text = results.length > maxResults
        ? results.slice(0, maxResults).join('\n') + '\n... (truncated)'
        : results.join('\n')
      return { content: truncateContent(text, 12000, 6000, 4000) }
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err)
      return { content: `Error: ${message}`, isError: true }
    }
  },

  requiresApproval: () => false,
  isConcurrencySafe: () => true,
  isEnabled: () => true,
}

function buildRegex(pattern: string, literal: boolean): RegExp | null {
  try {
    const source = literal ? pattern.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') : pattern
    return new RegExp(source)
  } catch {
    return null
  }
}

async function tryRipgrep(
  pattern: string,
  absPath: string,
  glob: string | undefined,
  maxResults: number,
  cwd: string,
  literal: boolean,
): Promise<ToolResult | null> {
  return new Promise((resolve) => {
    const args = [
      '--no-heading',
      '--line-number',
      '--max-count', String(maxResults),
      '--color', 'never',
    ]
    if (literal) {
      args.push('--fixed-strings')
    }
    if (glob) {
      args.push('--glob', glob)
    }
    args.push('--', pattern, absPath)

    let child: ReturnType<typeof spawn>
    try {
      child = spawn('rg', args, {
        cwd,
        env: { ...process.env },
        stdio: ['ignore', 'pipe', 'pipe'],
      })
    } catch {
      resolve(null)
      return
    }

    let stdout = ''
    let stderr = ''

    const timer = setTimeout(() => {
      child.kill('SIGTERM')
      resolve(null)
    }, TIMEOUT_MS)

    child.stdout!.on('data', (data: Buffer) => {
      stdout += data.toString()
    })

    child.stderr!.on('data', (data: Buffer) => {
      stderr += data.toString()
    })

    child.on('error', () => {
      clearTimeout(timer)
      resolve(null)
    })

    child.on('close', (code) => {
      clearTimeout(timer)
      if (code === 1) {
        // rg returns 1 when no matches — not an error
        resolve({ content: 'No matches found.' })
        return
      }
      if (code !== 0) {
        // rg not found or other error — fall back to native
        resolve(null)
        return
      }
      // Trim individual lines and cap at maxResults
      const lines = stdout.split('\n').filter(l => l.length > 0)
      const capped = lines.length > maxResults
        ? lines.slice(0, maxResults).join('\n') + '\n... (truncated)'
        : lines.join('\n')
      resolve({ content: truncateContent(capped, 12000, 6000, 4000) })
    })
  })
}

async function nativeSearch(
  absPath: string,
  regex: RegExp,
  glob: string | undefined,
  maxResults: number,
  cwd: string,
): Promise<string[]> {
  const filter = new GitignoreFilter(cwd)
  const globRegex = glob ? globToRegex(glob) : null
  const results: string[] = []
  const visited = new Set<string>()

  async function walk(dir: string): Promise<void> {
    if (results.length >= maxResults) return
    const entries = await readdir(dir, { withFileTypes: true })
    for (const entry of entries) {
      if (results.length >= maxResults) return
      const fullPath = join(dir, entry.name)
      if (visited.has(fullPath)) continue
      visited.add(fullPath)

      if (entry.isDirectory()) {
        await walk(fullPath)
      } else if (entry.isFile()) {
        const relPath = relative(cwd, fullPath)
        if (filter.isIgnored(cwd, fullPath)) continue
        if (globRegex && !globRegex.test(entry.name)) continue

        try {
          const matched = await searchFile(fullPath, regex)
          for (const line of matched) {
            results.push(`${relPath}:${line}`)
            if (results.length >= maxResults) return
          }
        } catch {
          // Skip unreadable/binary files
        }
      }
    }
  }

  const s = await stat(absPath)
  if (s.isFile()) {
    const relPath = relative(cwd, absPath)
    const matched = await searchFile(absPath, regex)
    for (const line of matched) {
      results.push(`${relPath}:${line}`)
      if (results.length >= maxResults) return results
    }
  } else {
    await walk(absPath)
  }

  return results
}

async function searchFile(filePath: string, regex: RegExp): Promise<string[]> {
  const results: string[] = []
  const stream = createReadStream(filePath, { encoding: 'utf-8' })
  const rl = createInterface({ input: stream, crlfDelay: Infinity })

  let lineNum = 0
  for await (const line of rl) {
    lineNum++
    if (regex.test(line)) {
      results.push(`${lineNum}:  ${line}`)
    }
  }

  stream.destroy()
  return results
}

function globToRegex(glob: string): RegExp {
  // Support brace expansion: *.{ts,tsx} → *.ts or *.tsx
  const braceMatch = glob.match(/^(.*)\{([^}]+)\}(.*)$/)
  let patterns: string[]
  if (braceMatch) {
    const [, prefix, group, suffix] = braceMatch
    const options = group!.split(',')
    patterns = options.map(o => prefix! + o + suffix!)
  } else {
    patterns = [glob]
  }

  const regexes = patterns.map(p =>
    p
      .replace(/[.+^${}()|[\]\\]/g, '\\$&')
      .replace(/\*/g, '.*')
      .replace(/\?/g, '.'),
  )
  return new RegExp(`^(${regexes.join('|')})$`)
}
