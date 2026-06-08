import { spawn } from 'child_process'
import { createReadStream } from 'fs'
import { lstat, readdir, realpath } from 'fs/promises'
import { join } from 'path'
import { createInterface } from 'readline'
import type { Tool, ToolCallParams, ToolResult } from './types.js'
import { relativePosix } from '../path-format.js'
import { truncateContent } from './truncation.js'
import { GitignoreFilter } from './gitignore.js'
import { validatePathSafe } from './path-validate.js'
import { summarizeGrepResult } from '../artifact/summarize.js'
import type { ArtifactStore } from '../artifact/store.js'
import { computeModelReadCap, type ModelReadCap } from './model-read-cap.js'
import { getToolArtifactThreshold } from './artifact-threshold.js'
import { debugLog } from '../utils/debug.js'
import { track } from './process-tracker.js'
import { gracefulKill } from '../platform.js'

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
Good: grep(pattern="class Foo", path="src/", context_lines=3)
Bad: grep(pattern="x") (too broad — will match too many lines)`,
    input_schema: {
      type: 'object',
      properties: {
        pattern: { type: 'string', description: 'Regex or literal pattern to search for' },
        path: { type: 'string', description: 'Directory or file to search (default: cwd)' },
        glob: { type: 'string', description: 'File filter e.g. "*.ts" or "*.{ts,tsx}"' },
        max_results: { type: 'integer', description: 'Max matching lines (default: 100)' },
        literal: { type: 'boolean', description: 'Treat pattern as literal, not regex (default: false)' },
        context_lines: { type: 'integer', description: 'Number of context lines before and after each match (default: 0). Use 2-3 to see surrounding code without a separate read_file.' },
      },
      required: ['pattern'],
    },
  },

  async execute(params: ToolCallParams): Promise<ToolResult> {
    const pattern = params.input.pattern as string
    const searchPath = (params.input.path as string) ?? '.'
    const glob = params.input.glob as string | undefined
    const maxResults = (params.input.max_results as number) ?? MAX_RESULTS_DEFAULT
    const literal = (params.input.literal as boolean) ?? false
    const contextLines = (params.input.context_lines as number) ?? 0
    const modelCap = computeModelReadCap({
      contextWindow: params.contextWindow,
      providerProfile: params.providerProfile,
    })

    const validated = validatePathSafe(params.cwd, searchPath)
    if (!validated.ok) {
      return { content: `Error: ${validated.error}`, isError: true }
    }
    const absPath = validated.path

    const artifactThreshold = getToolArtifactThreshold('grep', params.contextWindow)

    // Try ripgrep first, fall back to native search
    const rgResult = await tryRipgrep(pattern, absPath, searchPath, glob, maxResults, params.cwd, literal, contextLines, modelCap, params.artifactStore, artifactThreshold)
    if (rgResult !== null) return rgResult

    // Native fallback
    const regex = buildRegex(pattern, literal)
    if (!regex) {
      return { content: `Error: Invalid pattern: ${pattern}`, isError: true }
    }

    try {
      const results = await nativeSearch(absPath, regex, glob, maxResults, params.cwd, contextLines)
      if (results.length === 0) {
        return { content: 'No matches found.' }
      }
      const text = results.length > maxResults
        ? results.slice(0, maxResults).join('\n') + '\n... (truncated)'
        : results.join('\n')
      const hintedText = appendLogRangeHints(text, searchPath)

      if (params.artifactStore) {
        if (hintedText.length < artifactThreshold) {
          debugLog(`[artifact-skip] tool=grep pattern=${pattern.slice(0, 40)} raw=${hintedText.length} threshold=${artifactThreshold}`)
          return { content: truncateContent(hintedText, modelCap.maxChars, modelCap.headChars, modelCap.tailChars) }
        }
        debugLog(`[artifact-wrap] tool=grep pattern=${pattern.slice(0, 40)} raw=${hintedText.length} threshold=${artifactThreshold}`)
        const { summary, sections } = summarizeGrepResult(hintedText, pattern)
        const artifactId = await params.artifactStore.save({
          tool: 'grep',
          target: searchPath,
          rawContent: hintedText,
          summary,
          sections,
        })
        const truncated = truncateContent(hintedText, modelCap.maxChars, modelCap.headChars, modelCap.tailChars)
        return {
          content: `${truncated}\n\n${summary}\nUse read_section(artifactId="${artifactId}", section="L1-L500") for the full match list.\n[artifact:${artifactId}]`,
        }
      }

      return { content: truncateContent(hintedText, modelCap.maxChars, modelCap.headChars, modelCap.tailChars) }
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

function isLogLikeFilePath(path: string): boolean {
  return /\.(?:log|jsonl|ndjson|out|err|trace)(?:\.\d+)?$/i.test(path)
}

function appendLogRangeHints(content: string, searchPath: string): string {
  if (!isLogLikeFilePath(searchPath)) return content
  const hints: string[] = []
  for (const line of content.split('\n')) {
    const match = line.match(/:(\d+):/) ?? line.match(/^(\d+):/)
    if (!match?.[1]) continue
    const offset = Math.max(1, Number(match[1]) - 20)
    hints.push(`- read_file(file_path="${searchPath}", offset=${offset}, limit<=80)`)
    if (hints.length >= 5) break
  }
  if (hints.length === 0) return content
  return `${content}\n\nSuggested next reads:\n${hints.join('\n')}`
}

async function tryRipgrep(
  pattern: string,
  absPath: string,
  searchPath: string,
  glob: string | undefined,
  maxResults: number,
  cwd: string,
  literal: boolean,
  contextLines: number,
  modelCap: ModelReadCap,
  artifactStore?: ArtifactStore,
  artifactThreshold: number = 0,
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
    if (contextLines > 0) {
      args.push('--context', String(contextLines))
    }
    args.push('--', pattern, absPath)

    let child: ReturnType<typeof spawn>
    try {
      child = track(spawn('rg', args, {
        cwd,
        env: { ...process.env },
        stdio: ['ignore', 'pipe', 'pipe'],
      }))
    } catch {
      resolve(null)
      return
    }

    let stdout = ''
    let lineCount = 0

    const timer = setTimeout(() => {
      gracefulKill(child)
      resolve(null)
    }, TIMEOUT_MS)

    child.stdout!.on('data', (data: Buffer) => {
      stdout += data.toString()
      const lines = stdout.split('\n')
      if (!stdout.endsWith('\n')) lines.pop()
      lineCount = lines.filter(l => l.length > 0).length
      if (lineCount >= maxResults || stdout.length > 200_000) {
        gracefulKill(child)
      }
    })

    child.stderr!.on('data', () => {})

    child.on('error', () => {
      clearTimeout(timer)
      resolve(null)
    })

    child.on('close', (code) => {
      clearTimeout(timer)
      if (code === 1) {
        resolve({ content: 'No matches found.' })
        return
      }
      if (code !== 0) {
        resolve(null)
        return
      }
      const lines = stdout.split('\n').filter(l => l.length > 0).slice(0, maxResults)
      const suffix = lineCount >= maxResults ? '\n... (truncated)' : ''
      const text = lines.join('\n') + suffix
      const hintedText = appendLogRangeHints(text, searchPath)

      if (artifactStore) {
        if (hintedText.length < artifactThreshold) {
          debugLog(`[artifact-skip] tool=grep(rg) pattern=${pattern.slice(0, 40)} raw=${hintedText.length} threshold=${artifactThreshold}`)
          resolve({ content: truncateContent(hintedText, modelCap.maxChars, modelCap.headChars, modelCap.tailChars) })
          return
        }
        debugLog(`[artifact-wrap] tool=grep(rg) pattern=${pattern.slice(0, 40)} raw=${hintedText.length} threshold=${artifactThreshold}`)
        const { summary, sections } = summarizeGrepResult(hintedText, pattern)
        void artifactStore.save({
          tool: 'grep',
          target: absPath,
          rawContent: hintedText,
          summary,
          sections,
        }).then(artifactId => {
          const truncated = truncateContent(hintedText, modelCap.maxChars, modelCap.headChars, modelCap.tailChars)
          resolve({
            content: `${truncated}\n\n${summary}\nUse read_section(artifactId="${artifactId}", section="L1-L500") for the full match list.\n[artifact:${artifactId}]`,
          })
        }).catch(() => {
          resolve({ content: truncateContent(hintedText, modelCap.maxChars, modelCap.headChars, modelCap.tailChars) })
        })
        return
      }

      resolve({ content: truncateContent(hintedText, modelCap.maxChars, modelCap.headChars, modelCap.tailChars) })
    })
  })
}

async function nativeSearch(
  absPath: string,
  regex: RegExp,
  glob: string | undefined,
  maxResults: number,
  cwd: string,
  contextLines: number = 0,
): Promise<string[]> {
  const filter = await GitignoreFilter.create(cwd)
  const globRegex = glob ? globToRegex(glob) : null
  const results: string[] = []
  const visited = new Set<string>()

  async function walk(dir: string): Promise<void> {
    if (results.length >= maxResults) return

    let real: string
    try {
      real = await realpath(dir)
    } catch {
      return
    }
    if (visited.has(real)) return
    visited.add(real)

    const entries = await readdir(dir, { withFileTypes: true })
    for (const entry of entries) {
      if (results.length >= maxResults) return
      const fullPath = join(dir, entry.name)
      const s = await lstat(fullPath).catch(() => null)
      if (!s || s.isSymbolicLink()) continue

      if (s.isDirectory()) {
        await walk(fullPath)
      } else if (s.isFile()) {
        const relPath = relativePosix(cwd, fullPath)
        if (filter.isIgnored(cwd, fullPath)) continue
        if (globRegex && !globRegex.test(entry.name)) continue

        const matched = await searchFile(fullPath, regex, maxResults - results.length, contextLines)
        for (const line of matched) {
          results.push(`${relPath}:${line}`)
          if (results.length >= maxResults) return
        }
      }
    }
  }

  const s = await lstat(absPath).catch(() => null)
  if (s?.isFile()) {
    const relPath = relativePosix(cwd, absPath)
    const matched = await searchFile(absPath, regex, maxResults, contextLines)
    for (const line of matched) {
      results.push(`${relPath}:${line}`)
      if (results.length >= maxResults) return results
    }
  } else {
    await walk(absPath)
  }

  return results
}

async function searchFile(
  filePath: string,
  regex: RegExp,
  remaining = Number.POSITIVE_INFINITY,
  contextLines = 0,
): Promise<string[]> {
  const allLines: string[] = []
  const matchLineNums: number[] = []

  const stream = createReadStream(filePath, { encoding: 'utf-8' })
  const rl = createInterface({ input: stream, crlfDelay: Infinity })

  let lineNum = 0
  for await (const line of rl) {
    lineNum++
    allLines.push(line)
    if (regex.test(line)) {
      matchLineNums.push(lineNum - 1) // 0-based index into allLines
      if (matchLineNums.length >= remaining) break
    }
  }

  rl.close()
  stream.destroy()

  if (contextLines <= 0 || matchLineNums.length === 0) {
    // No context — original behavior
    return matchLineNums.map(idx => `${idx + 1}:  ${allLines[idx]}`)
  }

  // With context: collect expanded line ranges, deduplicate, format
  const included = new Set<number>()
  for (const idx of matchLineNums) {
    for (let c = Math.max(0, idx - contextLines); c <= Math.min(allLines.length - 1, idx + contextLines); c++) {
      included.add(c)
    }
  }

  const results: string[] = []
  let prevLineNum = -1
  for (const lineNum_ of [...included].sort((a, b) => a - b)) {
    if (prevLineNum !== -1 && lineNum_ > prevLineNum + 1) {
      results.push('  ...')
    }
    const marker = matchLineNums.includes(lineNum_) ? '>' : ' '
    results.push(`${marker}${String(lineNum_ + 1).padStart(4)}│ ${allLines[lineNum_]}`)
    prevLineNum = lineNum_
  }
  return results
}

function globToRegex(glob: string): RegExp {
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
