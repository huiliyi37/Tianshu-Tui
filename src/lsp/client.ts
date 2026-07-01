import { formatDiagnostics, parseDiagnosticOutput, type Diagnostic } from './diagnostics.js'
import { isAbsolute, relative, join } from 'node:path'
import { spawn } from 'node:child_process'
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
 * (node_modules/.bin/tsc) via an **async** spawn.
 *
 * Previously this used spawnSync, which blocks the Node event loop for the
 * full duration of tsc (tens of seconds on mid-sized repos). Because
 * deliver_task runs typecheck synchronously inside a tool execution, this
 * froze the TUI render loop — the spinner ticker (120ms setInterval) could
 * not fire, so `⠴ analyzing… Nm Ns` appeared frozen during every commit.
 *
 * Async spawn lets tsc run in a subprocess while the event loop keeps turning:
 * the spinner animates, streaming continues, the UI stays responsive. The
 * local node_modules/.bin/tsc absolute path avoids the PATH hijacking risk
 * that spawnSync('npx', ...) had.
 *
 * Falls back to in-process require('typescript') when node_modules/.bin/tsc is
 * missing (e.g. production bundle without devDependencies).
 */
let _tscPath: string | null | undefined = undefined
let _tscMissingWarned = false

function resolveTscPath(cwd: string): string | null {
  if (_tscPath !== undefined) return _tscPath
  const bin = join(cwd, 'node_modules', '.bin')
  // Windows: the runnable executable is tsc.cmd; the extension-less `tsc` is a
  // POSIX shell script that spawn() cannot execute. Prefer the .cmd so the
  // typecheck gate actually runs on Windows.
  const candidates = process.platform === 'win32'
    ? [join(bin, 'tsc.cmd'), join(bin, 'tsc')]
    : [join(bin, 'tsc')]
  for (const candidate of candidates) {
    if (existsSync(candidate)) {
      _tscPath = candidate
      return candidate
    }
  }
  _tscPath = null
  return null
}

export async function runTypeCheck(cwd: string, filePath: string): Promise<LspCheckResult> {
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

  // Run tsc as an async subprocess — its heap is OS-reclaimed on exit, and the
  // event loop stays free so the TUI render loop keeps animating during commit.
  // --noEmit: type-check only, no output files.
  // --pretty false: machine-parseable format (file(line,col): error TSxxxx: msg).
  const result = await runTscSubprocess(tscPath, cwd)

  // tsc writes diagnostics to stdout when --pretty false (not stderr).
  // Exit code 0 = no errors; exit code 1 = type errors found; exit code 2+ = crash/panic.
  // We treat exit 0 and exit 1 as "ran ok" (the compiler completed).
  // Signal / timeout / spawn failure → ranOk = false.
  const ranOk = result.status === 0 || result.status === 1
  const output = result.stdout + result.stderr

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

/**
 * Spawn tsc as an async subprocess, collecting stdout/stderr and enforcing a
 * 2-minute timeout. Resolves to { status, stdout, stderr } mirroring spawnSync's
 * shape so the parsing logic above is unchanged. status is null on signal/timeout.
 */
function runTscSubprocess(tscPath: string, cwd: string): Promise<{ status: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    // Spawning a .cmd on modern Node requires a shell; quote the path so spaces
    // in the project directory (e.g. C:\Users\My Name) survive cmd.exe parsing.
    const useShell = process.platform === 'win32' && tscPath.toLowerCase().endsWith('.cmd')
    const command = useShell ? `"${tscPath}"` : tscPath
    const child = spawn(command, ['--noEmit', '--pretty', 'false'], {
      cwd,
      env: { ...process.env },
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
      shell: useShell,
    })

    let stdout = ''
    let stderr = ''
    // Cap accumulation at 10 MB (parity with the old spawnSync maxBuffer).
    const MAX = 10 * 1024 * 1024
    let killed = false

    const timer = setTimeout(() => {
      killed = true
      child.kill('SIGKILL')
    }, 120_000)

    child.stdout?.on('data', (chunk: Buffer) => {
      if (stdout.length < MAX) stdout += chunk.toString('utf8').slice(0, MAX - stdout.length)
    })
    child.stderr?.on('data', (chunk: Buffer) => {
      if (stderr.length < MAX) stderr += chunk.toString('utf8').slice(0, MAX - stderr.length)
    })

    child.on('error', () => {
      clearTimeout(timer)
      resolve({ status: null, stdout, stderr })
    })
    child.on('close', (code) => {
      clearTimeout(timer)
      // killed by timeout → treat as inconclusive (null status, same as spawnSync timeout)
      resolve({ status: killed ? null : code, stdout, stderr })
    })
  })
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

async function runTypeCheckInProcess(cwd: string, filePath: string): Promise<LspCheckResult> {
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
