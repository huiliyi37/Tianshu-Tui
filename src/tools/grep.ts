import { spawn } from 'child_process'
import { spawnHidden } from './spawn-hidden.js'
import { createReadStream } from 'fs'
import { lstat, readdir, realpath, readFile, stat } from 'fs/promises'
import { join, resolve } from 'path'
import { getResolvedEnv } from './resolved-env.js'
import { createInterface } from 'readline'
import type { Dirent } from 'node:fs'
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
import { hashLine } from './hash-edit.js'
import { registerGrepFileAccess } from './read-file.js'
import { isRestrictedPath } from '../platform/restricted-paths.js'
import { isScanExcludedDir } from './scan-excludes.js'

const MAX_RESULTS_DEFAULT = 100
const TIMEOUT_MS = 30_000

/** Safe label for debug logs — pattern may be missing if tool JSON is malformed. */
function grepPatternLabel(pattern: unknown): string {
  if (typeof pattern === 'string') return pattern.slice(0, 40)
  if (pattern == null) return '(missing)'
  return String(pattern).slice(0, 40)
}

function parseGrepPattern(input: Record<string, unknown>): string | null {
  const raw = input.pattern
  if (typeof raw !== 'string') return null
  const trimmed = raw.trim()
  return trimmed.length > 0 ? trimmed : null
}

/** 空结果 sentinel——search-pod-hook 靠 includes(此串) 识别「可信排除」，
 *  改文案必须与 hook 同步（用常量共享，禁止两边各自手抄）。 */
export const GREP_EMPTY_RESULT = '未找到匹配。'

export const GREP_TOOL: Tool = {
  definition: {
    name: 'grep',
    description: `用正则或字面量模式搜索文件内容。

### 用法
- 用 grep 在源码中查找函数、类、模式或关键字
- 优先用本工具而不是 bash grep/rg——更快，且遵守 .gitignore
- 结果按文件分组并带行号
- pattern 可以是正则（默认）或字面量字符串
- 不知道确切字符串或符号、需要按概念搜索时，改用 semantic_search

### 示例
Good: grep(pattern="function handleSubmit", path="src/")
Good: grep(pattern="API_KEY", path=".", glob="*.{ts,tsx}")
Good: grep(pattern="class Foo", path="src/", context_lines=3)
Bad: grep(pattern="x") (too broad — will match too many lines)`,
    input_schema: {
      type: 'object',
      properties: {
        pattern: { type: 'string', description: '要搜索的正则或字面量模式' },
        path: { type: 'string', description: '要搜索的目录或文件（默认：cwd）' },
        glob: { type: 'string', description: '文件过滤，如 "*.ts" 或 "*.{ts,tsx}"' },
        max_results: { type: 'integer', description: '最大匹配行数（默认：100）' },
        literal: { type: 'boolean', description: '把 pattern 按字面量处理，不当正则（默认：false）' },
        context_lines: { type: 'integer', description: '每个匹配前后附带的上下文行数（默认：0）。设 2-3 可直接看到周边代码，省去单独的 read_file。' },
      },
      required: ['pattern'],
    },
  },

  async execute(params: ToolCallParams): Promise<ToolResult> {
    const pattern = parseGrepPattern(params.input)
    if (pattern === null) {
      const keys = Object.keys(params.input).sort()
      const keySummary = keys.length > 0 ? keys.join(', ') : '(无)'
      const patternType = typeof params.input.pattern
      // Foreign keys (file_path, section, command, ...) are the fingerprint of
      // streaming argument pollution: a parallel tool_call's args got grafted
      // onto this grep call. Flag it so the root cause is visible at the tool
      // layer instead of a generic "pattern is required".
      const knownKeys = new Set(['pattern', 'path', 'glob', 'max_results', 'literal', 'context_lines'])
      const foreignKeys = keys.filter(k => !knownKeys.has(k))
      const pollutionHint = foreignKeys.length > 0
        ? ` Input 含有无关键（${foreignKeys.join(', ')}）——可能是流式 tool_call 参数污染，而非格式错误的 grep 调用。`
        : ''
      return {
        content: `错误：需要提供 pattern（非空字符串）。收到的 input keys：${keySummary}。pattern 类型：${patternType}。` +
          (keys.length === 0 ? ' Input 为空——参数可能在流式传输期间解析失败。' : '') +
          pollutionHint,
        isError: true,
      }
    }
    const searchPath = (params.input.path as string) ?? '.'
    const glob = params.input.glob as string | undefined
    const maxResults = (params.input.max_results as number) ?? MAX_RESULTS_DEFAULT
    const literal = (params.input.literal as boolean) ?? false
    const contextLines = (params.input.context_lines as number) ?? 0
    const modelCap = params.readCapOverride ?? computeModelReadCap({
      contextWindow: params.contextWindow,
      providerProfile: params.providerProfile,
    })

    const validated = validatePathSafe(params.cwd, searchPath)
    if (!validated.ok) {
      return { content: `错误：${validated.error}`, isError: true }
    }
    const absPath = validated.path

    const artifactThreshold = getToolArtifactThreshold('grep', params.contextWindow)

    // Try ripgrep first, fall back to native search
    const rgResult = await tryRipgrep(pattern, absPath, searchPath, glob, maxResults, params.cwd, literal, contextLines, modelCap, params.artifactStore, artifactThreshold, params.abortSignal, params.sessionId)
    if (rgResult !== null) return rgResult

    // Native fallback
    const regex = buildRegex(pattern, literal)
    if (!regex) {
      return { content: `错误：无效的模式：${pattern}`, isError: true, errorKind: 'syntax_error' }
    }

    try {
      const { results, timedOut } = await nativeSearch(absPath, regex, glob, maxResults, params.cwd, contextLines)
      // A partial result that reads like a complete one is worse than no result:
      // "no matches" would be taken as proof the string is absent.
      const TIMEOUT_NOTE = timedOut
        ? `[grep] 回退搜索在 ${TIMEOUT_MS / 1000}s 后超时，以下结果不完整——缩小 path 或改用更具体的 glob 重试。\n`
        : ''
      if (results.length === 0) {
        return { content: `[grep] 未找到 ripgrep (rg) 或其执行失败；已使用慢速回退。\n${TIMEOUT_NOTE}${timedOut ? '' : GREP_EMPTY_RESULT}` }
      }
      const FALLBACK_PREFIX = '[grep] 未找到 ripgrep (rg) 或其执行失败；已使用慢速回退。\n' + TIMEOUT_NOTE
      const text = results.length > maxResults
        ? FALLBACK_PREFIX + results.slice(0, maxResults).join('\n') + '\n...（已截断）'
        : FALLBACK_PREFIX + results.join('\n')
      let hintedText = appendLogRangeHints(text, searchPath)
      hintedText = await appendHashEditHints(hintedText, absPath, params.cwd, params.sessionId)
      await registerGrepFilesFromOutput(hintedText, params.cwd, params.sessionId)

      if (params.artifactStore) {
        if (hintedText.length < artifactThreshold) {
          debugLog(`[artifact-skip] tool=grep pattern=${grepPatternLabel(pattern)} raw=${hintedText.length} threshold=${artifactThreshold}`)
          return { content: truncateContent(hintedText, modelCap.maxChars, modelCap.headChars, modelCap.tailChars) }
        }
        debugLog(`[artifact-wrap] tool=grep pattern=${grepPatternLabel(pattern)} raw=${hintedText.length} threshold=${artifactThreshold}`)
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
          content: `${truncated}\n\n${summary}\n使用 read_section(artifactId="${artifactId}", section="L1-L500") 获取完整匹配列表。\n[artifact:${artifactId}]`,
        }
      }

      return { content: truncateContent(hintedText, modelCap.maxChars, modelCap.headChars, modelCap.tailChars) }
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err)
      return { content: `错误：${message}`, isError: true }
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
  return `${content}\n\n建议的下一步读取：\n${hints.join('\n')}`
}

/**
 * For single-file grep results, append hash_edit anchor hints so the model
 * can edit without a full read_file call: grep → hash_edit directly.
 *
 * Reads the file once, extracts hashes for matched line numbers, appends them.
 */
async function appendHashEditHints(content: string, absPath: string, cwd: string, sessionId?: string): Promise<string> {
  // Only add hints for single-file results (not directory-wide greps)
  let fileStat
  try {
    fileStat = await stat(absPath)
  } catch { return content }
  if (!fileStat.isFile()) return content

  registerGrepFileAccess(absPath, fileStat.mtimeMs, sessionId)

  const lineNumbers: number[] = []
  for (const line of content.split('\n')) {
    // rg output format: "42: line content" or ">  42│ content" (context mode)
    const m = line.match(/^>?\s*(\d+)[│:|]/) ?? line.match(/:(\d+):/)
    if (m?.[1]) {
      const num = parseInt(m[1], 10)
      if (num > 0 && !lineNumbers.includes(num)) lineNumbers.push(num)
    }
    if (lineNumbers.length >= 10) break
  }
  if (lineNumbers.length === 0) return content

  let fileLines: string[]
  try {
    const raw = await readFile(absPath, 'utf-8')
    fileLines = raw.split('\n')
  } catch { return content }

  const hints: string[] = []
  for (const num of lineNumbers) {
    if (num <= fileLines.length) {
      const h = hashLine(fileLines[num - 1]!)
      hints.push(`  L${num}:${h}`)
    }
  }
  if (hints.length === 0) return content

  const relPath = relativePosix(cwd, absPath)
  return `${content}\n\nhash_edit 锚点（${relPath}）：\n${hints.join('\n')}`
}

/**
 * Register file access from grep results for directory-wide greps.
 * Parses rg output lines to extract file paths, stats each, and registers
 * them in fileReadHistory so hash_edit can be used directly.
 */
async function registerGrepFilesFromOutput(content: string, cwd: string, sessionId?: string): Promise<void> {
  const seen = new Set<string>()
  for (const line of content.split('\n')) {
    // rg --no-heading format: "relative/path:linenum: content"
    const m = line.match(/^(.+?):(\d+):/)
    if (!m?.[1]) continue
    const relPath = m[1]
    if (seen.has(relPath)) continue
    seen.add(relPath)
    try {
      const absFilePath = resolve(cwd, relPath)
      const s = await stat(absFilePath)
      if (s.isFile()) {
        registerGrepFileAccess(absFilePath, s.mtimeMs, sessionId)
      }
    } catch { /* skip unresolvable paths */ }
    if (seen.size >= 20) break
  }
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
  abortSignal?: AbortSignal,
  sessionId?: string,
): Promise<ToolResult | null> {
  if (typeof pattern !== 'string' || pattern.length === 0) {
    return Promise.resolve({ content: '错误：需要提供 pattern（非空字符串）', isError: true })
  }

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
      child = track(spawnHidden('rg', args, {
        cwd,
        env: getResolvedEnv(cwd),
        stdio: ['ignore', 'pipe', 'pipe'],
      }))
    } catch (err) {
      debugLog(`[grep] rg spawn failed: ${err instanceof Error ? err.message : String(err)}`)
      resolve(null)
      return
    }

    let stdout = ''
    let lineCount = 0
    // 结果收够后我们自己 kill rg。必须记下来：signal kill 让 close 的 code 变成 null，
    // 不区分就会把这条成功路径当成 rg 失败，丢弃已收结果去跑慢速全树扫描。
    let killedAtCap = false

    const timer = setTimeout(() => {
      debugLog(`[grep] rg timed out after ${TIMEOUT_MS}ms, falling back: pattern=${grepPatternLabel(pattern)}`)
      gracefulKill(child)
      resolve(null)
    }, TIMEOUT_MS)

    // 用户中止（Esc/Ctrl+C）：协作式取消，kill rg 子进程。
    // 没有这一步，rg 在 abort 后继续跑到 30s 超时才停。
    const onAbort = () => {
      clearTimeout(timer)
      gracefulKill(child)
      resolve(null)
    }
    if (abortSignal) {
      if (abortSignal.aborted) onAbort()
      else abortSignal.addEventListener('abort', onAbort, { once: true })
    }

    child.stdout!.on('data', (data: Buffer) => {
      stdout += data.toString()
      const lines = stdout.split('\n')
      if (!stdout.endsWith('\n')) lines.pop()
      lineCount = lines.filter(l => l.length > 0).length
      if (lineCount >= maxResults || stdout.length > 200_000) {
        killedAtCap = true
        gracefulKill(child)
      }
    })

    child.stderr!.on('data', () => {})

    child.on('error', (err) => {
      clearTimeout(timer)
      if (abortSignal) abortSignal.removeEventListener('abort', onAbort)
      debugLog(`[grep] rg process error: ${err.message}`)
      resolve(null)
    })

    child.on('close', (code, signal) => {
      clearTimeout(timer)
      if (abortSignal) abortSignal.removeEventListener('abort', onAbort)
      if (!killedAtCap) {
        if (code === 1) {
          resolve({ content: GREP_EMPTY_RESULT })
          return
        }
        if (code !== 0) {
          debugLog(`[grep] rg fallback: code=${code} signal=${signal} pattern=${grepPatternLabel(pattern)}`)
          resolve(null)
          return
        }
      }
      const lines = stdout.split('\n').filter(l => l.length > 0).slice(0, maxResults)
      const suffix = killedAtCap || lineCount >= maxResults ? '\n...（已截断）' : ''
      const text = lines.join('\n') + suffix
      let hintedText = appendLogRangeHints(text, searchPath)

      void (async () => {
        hintedText = await appendHashEditHints(hintedText, absPath, cwd, sessionId)
        await registerGrepFilesFromOutput(hintedText, cwd, sessionId)

        if (artifactStore) {
          if (hintedText.length < artifactThreshold) {
            debugLog(`[artifact-skip] tool=grep(rg) pattern=${grepPatternLabel(pattern)} raw=${hintedText.length} threshold=${artifactThreshold}`)
            resolve({ content: truncateContent(hintedText, modelCap.maxChars, modelCap.headChars, modelCap.tailChars) })
            return
          }
          debugLog(`[artifact-wrap] tool=grep(rg) pattern=${grepPatternLabel(pattern)} raw=${hintedText.length} threshold=${artifactThreshold}`)
          const { summary, sections } = summarizeGrepResult(hintedText, pattern)
          try {
            const artifactId = await artifactStore.save({
              tool: 'grep',
              target: absPath,
              rawContent: hintedText,
              summary,
              sections,
            })
            const truncated = truncateContent(hintedText, modelCap.maxChars, modelCap.headChars, modelCap.tailChars)
            resolve({
              content: `${truncated}\n\n${summary}\n使用 read_section(artifactId="${artifactId}", section="L1-L500") 获取完整匹配列表。\n[artifact:${artifactId}]`,
            })
          } catch {
            resolve({ content: truncateContent(hintedText, modelCap.maxChars, modelCap.headChars, modelCap.tailChars) })
          }
          return
        }

        resolve({ content: truncateContent(hintedText, modelCap.maxChars, modelCap.headChars, modelCap.tailChars) })
      })()
    })
  })
}

interface NativeSearchOutcome {
  results: string[]
  /** Hit the deadline — `results` is whatever the walk reached in time. */
  timedOut: boolean
}

async function nativeSearch(
  absPath: string,
  regex: RegExp,
  glob: string | undefined,
  maxResults: number,
  cwd: string,
  contextLines: number = 0,
): Promise<NativeSearchOutcome> {
  const filter = await GitignoreFilter.create(cwd)
  const globRegex = glob ? globToRegex(glob) : null
  const results: string[] = []
  const visited = new Set<string>()
  // Same budget ripgrep gets. Without one this walk is unbounded: it is only
  // reached when rg is missing or already timed out, i.e. exactly when the tree
  // is hostile.
  const deadline = Date.now() + TIMEOUT_MS
  let timedOut = false

  /** Deadline check that latches the flag, so the reason survives the unwind. */
  function outOfTime(): boolean {
    if (Date.now() < deadline) return false
    timedOut = true
    return true
  }

  async function walk(dir: string, isRoot: boolean): Promise<void> {
    if (results.length >= maxResults) return
    if (outOfTime()) return

    let real: string
    try {
      real = await realpath(dir)
    } catch {
      return
    }
    if (visited.has(real)) return
    visited.add(real)

    let entries: Dirent[]
    try {
      entries = await readdir(dir, { withFileTypes: true })
    } catch (err) {
      const e = err as NodeJS.ErrnoException
      // Non-root + known restricted system path + permission error → silent skip.
      // Root or other errors → propagate (outer catch → isError:true).
      if (!isRoot && isRestrictedPath(String(e.path ?? e.message ?? ''), e.code ?? '')) return
      throw err
    }
    for (const entry of entries) {
      if (results.length >= maxResults) return
      if (outOfTime()) return
      // Prune before the lstat. Descending costs a readdir plus an lstat for
      // every entry below, and the per-file gitignore check further down cannot
      // refund any of it — it runs after the walk has already paid.
      if (entry.isDirectory() && isScanExcludedDir(entry.name)) continue
      const fullPath = join(dir, entry.name)
      const s = await lstat(fullPath).catch(() => null)
      if (!s || s.isSymbolicLink()) continue

      if (s.isDirectory()) {
        await walk(fullPath, false)
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
      if (results.length >= maxResults) return { results, timedOut }
    }
  } else {
    await walk(absPath, true)
  }

  return { results, timedOut }
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
