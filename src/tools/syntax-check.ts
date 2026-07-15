import { extname } from 'path'
import { createRequire } from 'node:module'
import { spawn } from 'node:child_process'
import { getResolvedEnv } from './resolved-env.js'

// esbuild ships a native binary, so it can't be inlined into the tsup bundle.
// Load it lazily via require so a packaged sidecar without esbuild on disk
// degrades (skips the JS/TS parse check) instead of crashing at startup with
// ERR_MODULE_NOT_FOUND. Resolved once, then cached (null = unavailable).
//
// We use the async `transform()` API so esbuild runs on its own worker thread
// and never blocks the main event loop (plan: cpu-pool). The sync
// `transformSync` version is kept as an inline fallback if async isn't
// available (very old esbuild), but it is gated behind a 2 MB size limit.

type TransformFn = (input: string, options: Record<string, unknown>) => Promise<unknown>
type TransformSync = (input: string, options: Record<string, unknown>) => unknown

interface EsbuildModule {
  transform: TransformFn
  transformSync: TransformSync
}

let _esbuildPromise: Promise<EsbuildModule | null> | undefined

async function loadEsbuildModule(): Promise<EsbuildModule | null> {
  try {
    const req = createRequire(import.meta.url)
    return req('esbuild') as EsbuildModule
  } catch {
    return null
  }
}

async function getEsbuild(): Promise<EsbuildModule | null> {
  if (_esbuildPromise) return _esbuildPromise
  _esbuildPromise = withTimeout(
    loadEsbuildModule(),
    'esbuild load',
    getEsbuildLoadTimeoutMs(),
  ).catch(() => null)
  return _esbuildPromise
}

/** Test-only: clear the esbuild load cache so each test gets a fresh load attempt. */
export function _resetEsbuildCacheForTest(): void {
  _esbuildPromise = undefined
}

/** Files larger than this skip CSS/HTML/JSON branch checks (O(n) scans). */
const SYNC_SCAN_SIZE_LIMIT = 2 * 1024 * 1024 // 2 MB

/** Files larger than this skip external-parser checks (Python AST, esbuild). */
const EXTERNAL_PARSE_SIZE_LIMIT = 8 * 1024 * 1024 // 8 MB

/** Timeout for esbuild async transform — prevents a hung worker from blocking
 *  the tool call indefinitely (file is already written; losing syntax-check is
 *  a degradation, not a failure). */
const TRANSFORM_TIMEOUT_MS = 5000

/** Timeout for loading the esbuild module itself.
 *
 *  esbuild ships a native binary; on Windows with certain antivirus/EDR
 *  configurations the first require() of the native addon can block the event
 *  loop for minutes. Because the default 2-minute tool timeout uses setTimeout,
 *  a blocked event loop never fires it, so the edit_file call appears to hang
 *  for 5-10 minutes with the UI stuck on "thinking". Loading esbuild async with
 *  a short timeout keeps the event loop alive and lets us degrade gracefully
 *  (skip the parse check) when the binary is slow to arrive.
 *
 *  Override with RIVET_ESBUILD_LOAD_TIMEOUT (ms); set to 0/negative to fall
 *  back to the 3s default. */
function getEsbuildLoadTimeoutMs(): number {
  const v = Number.parseInt(process.env.RIVET_ESBUILD_LOAD_TIMEOUT ?? '', 10)
  return Number.isFinite(v) && v > 0 ? v : 3000
}

/** Timeout for the python3 AST parse child process. A hung interpreter (blocked
 *  import, stuck stdin, slow environment) would otherwise leave the promise
 *  unresolved and stall the whole turn. Override with RIVET_PY_SYNTAX_TIMEOUT
 *  (ms); set to 0/negative to fall back to the 5s default. Read lazily so the
 *  env override is honoured (and testable) without a module reload. */
function getPySyntaxTimeoutMs(): number {
  const v = Number.parseInt(process.env.RIVET_PY_SYNTAX_TIMEOUT ?? '', 10)
  return Number.isFinite(v) && v > 0 ? v : 5000
}

function withTimeout<T>(promise: Promise<T>, label: string, timeoutMs: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${label} timed out after ${timeoutMs}ms`)), timeoutMs)
    promise.then(
      value => { clearTimeout(timer); resolve(value) },
      error => { clearTimeout(timer); reject(error) },
    )
  })
}

export interface SyntaxCheckResult {
  /** Non-fatal lint/style warning to display to the model. */
  warning: string | null
  /** Fatal parse/integrity error. If set, the caller should roll back the write. */
  fatal: string | null
}

const OK: SyntaxCheckResult = { warning: null, fatal: null }

/**
 * Language-agnostic syntax and structural integrity check for written files.
 *
 * Runs after write in edit_file / write_file / hash_edit.
 * Catches syntax errors (missing bracket, broken JSX, unbalanced braces,
 * truncated JSON, unclosed HTML tags) in ~2ms per file and embeds the
 * warning directly into the ToolResult — so the model sees the error
 * immediately instead of discovering it 2–3 turns later.
 *
 * Supported: .ts .tsx .js .jsx (esbuild parser, async), .py (Python AST),
 * .css (brace balance), .html (tag balance), .json (JSON.parse).
 *
 * Returns null if clean or unsupported extension.
 * Returns a warning string if an integrity issue is detected.
 */
export async function syntaxCheck(filePath: string, content: string): Promise<string | null> {
  const result = await checkSyntax(filePath, content)
  return result.warning
}

/**
 * Strict syntax check that distinguishes fatal parse errors from warnings.
 * Fatal errors indicate the file is corrupted or unparseable and should be
 * rolled back by the caller.
 */
export async function checkSyntax(filePath: string, content: string): Promise<SyntaxCheckResult> {
  const ext = extname(filePath)

  // ── TypeScript/JavaScript via esbuild async transform ──
  if (ext === '.ts' || ext === '.tsx' || ext === '.js' || ext === '.jsx' || ext === '.mjs' || ext === '.cjs') {
    if (content.length > EXTERNAL_PARSE_SIZE_LIMIT) return OK
    const loaderMap: Record<string, 'ts' | 'tsx' | 'js' | 'jsx'> = {
      '.ts': 'ts', '.tsx': 'tsx', '.js': 'js', '.jsx': 'jsx', '.mjs': 'js', '.cjs': 'js',
    }
    const loader = loaderMap[ext] ?? 'js'
    const esbuild = await getEsbuild()
    if (!esbuild) return OK
    try {
      if (esbuild.transform) {
        await withTimeout(
          esbuild.transform(content, { loader, target: 'esnext', jsx: 'automatic' }),
          'esbuild transform',
          TRANSFORM_TIMEOUT_MS,
        )
      } else {
        esbuild.transformSync(content, { loader, target: 'esnext', jsx: 'automatic' })
      }
      return OK
    } catch (err) {
      if (!(err instanceof Error)) return OK
      const lines = err.message.split('\n')
      const errorLines = lines.filter(l => /ERROR:|error:/i.test(l))
      const detail = errorLines.length > 0
        ? errorLines.join('\n')
        : lines.slice(1).join('\n')
      const cleaned = detail.replace(/<stdin>:/g, '')
      const message = `⚠️ Syntax error detected in ${ext}:\n${cleaned}\n\nThe file was written but will fail at runtime.`
      return { warning: message, fatal: message }
    }
  }

  // ── Python: AST parse via system python3 ──
  if (ext === '.py') {
    if (content.length > EXTERNAL_PARSE_SIZE_LIMIT) return OK
    const result = await checkPythonSyntax(content)
    if (result.error) {
      const message = `⚠️ Python syntax error:\n${result.error}\n\nThe file was written but will fail to import/execute.`
      return { warning: message, fatal: message }
    }
    return OK
  }

  // ── CSS: brace balance check (skip if >2MB) ──
  if (ext === '.css') {
    if (content.length > SYNC_SCAN_SIZE_LIMIT) return OK
    let depth = 0
    let inString = false
    let stringChar = ''
    let inComment = false
    for (let i = 0; i < content.length; i++) {
      const c = content[i]
      const prev = content[i - 1] ?? ''
      if (inComment) {
        if (c === '/' && prev === '*') inComment = false
        continue
      }
      if (c === '/' && content[i + 1] === '*') { inComment = true; i++; continue }
      if (inString) {
        if (c === stringChar && prev !== '\\') inString = false
        continue
      }
      if (c === '"' || c === "'") { inString = true; stringChar = c; continue }
      if (c === '{') depth++
      if (c === '}') depth--
      if (depth < 0) {
        const msg = `⚠️ CSS brace mismatch: unmatched '}' at position ${i}. Remove the extra closing brace.`
        return { warning: msg, fatal: msg }
      }
    }
    if (depth > 0) {
      const msg = `⚠️ CSS brace mismatch: ${depth} unmatched '{' (missing closing '}'). Check for unclosed blocks like @media or rule sets.`
      return { warning: msg, fatal: msg }
    }
    return OK
  }

  // ── HTML: basic tag balance (skip if >2MB) ──
  if (ext === '.html' || ext === '.htm') {
    if (content.length > SYNC_SCAN_SIZE_LIMIT) return OK
    const voids = new Set([
      'area','base','br','col','embed','hr','img','input','link','meta',
      'param','source','track','wbr',
    ])
    const openTagRe = /<\/?([a-zA-Z][a-zA-Z0-9]*)[^>]*\/?>/g
    const stack: { tag: string; pos: number }[] = []
    let match
    while ((match = openTagRe.exec(content)) !== null) {
      const full = match[0]
      const tag = match[1]!.toLowerCase()
      const isClose = full.startsWith('</')
      const isSelfClose = full.endsWith('/>')
      if (isSelfClose || voids.has(tag)) continue
      if (isClose) {
        if (stack.length === 0 || stack[stack.length - 1]!.tag !== tag) {
          const expected = stack.length > 0 ? stack[stack.length - 1]!.tag : 'nothing'
          const msg = `⚠️ HTML tag mismatch: unexpected </${tag}> at position ${match.index} (expected </${expected}>)`
          return { warning: msg, fatal: msg }
        }
        stack.pop()
      } else {
        stack.push({ tag, pos: match.index })
      }
    }
    if (stack.length > 0) {
      const unclosed = stack.map(s => `<${s.tag}>`).join(', ')
      const msg = `⚠️ HTML tag mismatch: ${stack.length} unclosed tag(s): ${unclosed}. Add the missing closing tags.`
      return { warning: msg, fatal: msg }
    }
    return OK
  }

  // ── JSON: parse check (skip if >2MB) ──
  if (ext === '.json') {
    if (content.length > SYNC_SCAN_SIZE_LIMIT) return OK
    try {
      JSON.parse(content)
      return OK
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      const message = `⚠️ Invalid JSON: ${msg}`
      return { warning: message, fatal: message }
    }
  }

  return OK
}

interface PythonSyntaxResult {
  ok: boolean
  error?: string
}

/** Parse Python source via system python3 -c "import ast; ast.parse(...)".
 *  Returns {ok:true} on clean parse OR on any infrastructure failure (missing
 *  interpreter, spawn error, timeout kill) — those must NEVER masquerade as a
 *  fatal syntax error, since the caller rolls back the write on `error`.
 *  Only a genuine non-zero exit with parser output is reported as {ok:false}.
 *  Uses a child process because there is no robust pure-JS Python parser in
 *  the dependency tree, and SWE-bench is overwhelmingly Python. */
function checkPythonSyntax(content: string): Promise<PythonSyntaxResult> {
  const isWin = process.platform === 'win32'
  const candidates: Array<{ command: string; args: string[] }> = isWin
    ? [
        { command: 'py', args: ['-3', '-c', 'import ast,sys; ast.parse(sys.stdin.read())'] },
        { command: 'python', args: ['-c', 'import ast,sys; ast.parse(sys.stdin.read())'] },
        { command: 'python3', args: ['-c', 'import ast,sys; ast.parse(sys.stdin.read())'] },
      ]
    : [
        { command: 'python3', args: ['-c', 'import ast,sys; ast.parse(sys.stdin.read())'] },
        { command: 'python', args: ['-c', 'import ast,sys; ast.parse(sys.stdin.read())'] },
      ]

  async function tryCandidate(candidate: typeof candidates[number]): Promise<PythonSyntaxResult | null> {
    return new Promise((resolve) => {
      let child: ReturnType<typeof spawn>
      try {
        child = spawn(candidate.command, candidate.args, {
          stdio: ['pipe', 'pipe', 'pipe'],
          env: getResolvedEnv(),
          windowsHide: true,
        })
      } catch {
        resolve(null) // ENOENT — try next candidate
        return
      }

      const timer = setTimeout(() => {
        try { child.kill('SIGKILL') } catch { /* already exited */ }
        resolve({ ok: true })
      }, getPySyntaxTimeoutMs())

      let stdout = ''
      let stderr = ''
      child.stdout?.on('data', (d: Buffer) => { stdout += d.toString() })
      child.stderr?.on('data', (d: Buffer) => { stderr += d.toString() })
      child.on('close', (code) => {
        clearTimeout(timer)
        if (code === 0 || code === null) {
          resolve({ ok: true })
        } else {
          resolve({ ok: false, error: stderr.trim() || stdout.trim() || `${candidate.command} exited with code ${code}` })
        }
      })
      child.on('error', () => {
        clearTimeout(timer)
        resolve(null) // ENOENT — try next candidate
      })
      try {
        child.stdin?.write(content)
        child.stdin?.end()
      } catch { /* stdin closed early */ }
    })
  }

  return (async () => {
    for (const candidate of candidates) {
      const result = await tryCandidate(candidate)
      if (result !== null) return result
    }
    // All candidates failed — degrade to OK
    return { ok: true }
  })()
}
