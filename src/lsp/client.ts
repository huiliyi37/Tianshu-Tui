import { formatDiagnostics, parseDiagnosticOutput, type Diagnostic } from './diagnostics.js'
import { isAbsolute, relative, join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'

export interface LspCheckResult {
  diagnostics: Diagnostic[]
  formatted: string
  /** Whether tsc actually completed. false when killed by signal / timed out /
   *  failed to spawn — in that case `diagnostics` is partial and untrustworthy,
   *  so callers should treat the run as inconclusive (fail-open). */
  ranOk: boolean
}

/**
 * Run a real TypeScript type check using the project-local tsc binary
 * (node_modules/.bin/tsc) via spawnSync.
 *
 * Previously this used the TypeScript compiler API (require('typescript') +
 * ts.createProgram) in-process. That loaded and parsed ALL project files into
 * the main V8 heap, allocating 500 MB–1 GB per call on mid-sized repos.
 * Repeated deliver_task calls drove the heap to the 1.5 GB default limit,
 * triggering "Ineffective mark-compacts near heap limit" OOM kills.
 *
 * spawnSync runs tsc as a subprocess — its heap is separate and reclaimed by
 * the OS on exit. The local node_modules/.bin/tsc absolute path avoids the
 * PATH hijacking risk that the original spawnSync('npx', ...) had: a global
 * tsc wrapper cannot intercept a direct filesystem path.
 *
 * Falls back to in-process require('typescript') when node_modules/.bin/tsc is
 * missing (e.g. production bundle without devDependencies).
 */
let _tscPath: string | null | undefined = undefined
let _tscMissingWarned = false

function resolveTscPath(cwd: string): string | null {
  if (_tscPath !== undefined) return _tscPath
  const candidate = join(cwd, 'node_modules', '.bin', 'tsc')
  if (existsSync(candidate)) {
    _tscPath = candidate
    return candidate
  }
  _tscPath = null
  return null
}

export function runTypeCheck(cwd: string, filePath: string): LspCheckResult {
  const tscPath = resolveTscPath(cwd)

  if (!tscPath) {
    // node_modules/.bin/tsc missing — fall back to in-process compiler API.
    // Warn once so silent degradation is discoverable.
    if (!_tscMissingWarned) {
      _tscMissingWarned = true
      process.stderr.write(
        `[rivet] typecheck gate: node_modules/.bin/tsc not found, falling back to in-process ts.createProgram.\n` +
        `  Install typescript as a devDependency (npm i -D typescript) for subprocess isolation.\n`,
      )
    }
    return runTypeCheckInProcess(cwd, filePath)
  }

  // Run tsc as a subprocess — its heap is OS-reclaimed on exit.
  // --noEmit: type-check only, no output files.
  // --pretty false: machine-parseable format (file(line,col): error TSxxxx: msg).
  const result = spawnSync(tscPath, ['--noEmit', '--pretty', 'false'], {
    cwd,
    encoding: 'utf-8',
    timeout: 120_000, // 2 min — generous for large projects, fail-open on timeout
    maxBuffer: 10 * 1024 * 1024, // 10 MB — enough for thousands of errors
    env: { ...process.env },
  })

  // tsc writes diagnostics to stdout when --pretty false (not stderr).
  // Exit code 0 = no errors; exit code 1 = type errors found; exit code 2+ = crash/panic.
  // We treat exit 0 and exit 1 as "ran ok" (the compiler completed).
  // Signal / timeout / spawn failure → ranOk = false.
  const ranOk = result.status === 0 || result.status === 1
  const output = (result.stdout ?? '') + (result.stderr ?? '')

  const allDiagnostics = ranOk ? parseDiagnosticOutput(output, 'ts') : []

  // Filter by filePath if not '*'
  const filtered = filePath === '*'
    ? allDiagnostics
    : allDiagnostics.filter(d => d.file.includes(filePath))

  return {
    diagnostics: filtered,
    formatted: formatDiagnostics(filtered),
    ranOk,
  }
}

// ── In-process fallback (only when node_modules/.bin/tsc is missing) ──────

import { createRequire } from 'node:module'

let _tsModule: typeof import('typescript') | undefined
let _tsLoadAttempted = false

function loadTsModule(): typeof import('typescript') | undefined {
  if (_tsLoadAttempted) return _tsModule
  _tsLoadAttempted = true
  try {
    const require = createRequire(import.meta.url)
    _tsModule = require('typescript') as typeof import('typescript')
  } catch {
    // typescript module not available — fail-open.
  }
  return _tsModule
}

function runTypeCheckInProcess(cwd: string, filePath: string): LspCheckResult {
  const ts = loadTsModule()
  if (!ts) {
    return { diagnostics: [], formatted: '', ranOk: false }
  }

  const configPath = ts.findConfigFile(cwd, ts.sys.fileExists, 'tsconfig.json')
  if (!configPath) {
    return { diagnostics: [], formatted: '', ranOk: false }
  }

  const configFile = ts.readConfigFile(configPath, ts.sys.readFile)
  if (configFile.error) {
    return { diagnostics: [], formatted: '', ranOk: false }
  }

  const parsed = ts.parseJsonConfigFileContent(
    configFile.config,
    ts.sys,
    cwd,
  )

  const program = ts.createProgram(parsed.fileNames, {
    ...parsed.options,
    noEmit: true,
    pretty: false,
  })

  const allDiagnostics = ts.getPreEmitDiagnostics(program)

  const diagnostics: Diagnostic[] = []
  for (const d of allDiagnostics) {
    const category = ts.DiagnosticCategory
    const severity: Diagnostic['severity'] =
      d.category === category.Error ? 'error'
      : d.category === category.Warning ? 'warning'
      : 'info'
    const file = d.file
    if (!file) continue
    const absFile = file.fileName
    const relFile = isAbsolute(absFile) ? relative(cwd, absFile) : absFile
    const lineChar = ts.getLineAndCharacterOfPosition(file, d.start ?? 0)
    diagnostics.push({
      file: relFile,
      line: lineChar.line + 1,
      col: lineChar.character + 1,
      severity,
      message: ts.flattenDiagnosticMessageText(d.messageText, '\n'),
    })
  }

  const filtered = filePath === '*'
    ? diagnostics
    : diagnostics.filter(d => d.file.includes(filePath))

  return {
    diagnostics: filtered,
    formatted: formatDiagnostics(filtered),
    ranOk: true,
  }
}

export function shouldRunDiagnostics(toolName: string, filePath?: string): boolean {
  if (toolName !== 'write_file' && toolName !== 'edit_file') return false
  if (!filePath) return false
  return /\.(ts|tsx|js|jsx)$/.test(filePath)
}
