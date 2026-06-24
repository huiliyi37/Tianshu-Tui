import { formatDiagnostics, type Diagnostic } from './diagnostics.js'
import { isAbsolute, relative } from 'node:path'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)

export interface LspCheckResult {
  diagnostics: Diagnostic[]
  formatted: string
  /** Whether tsc actually completed. false when killed by signal / timed out /
   *  failed to spawn — in that case `diagnostics` is partial and untrustworthy,
   *  so callers should treat the run as inconclusive (fail-open). */
  ranOk: boolean
}

/**
 * Run a real TypeScript type check using the project-local typescript compiler
 * API (require('typescript')), bypassing npx/PATH entirely.
 *
 * The previous implementation used spawnSync('npx', ['tsc', ...]) which is
 * vulnerable to PATH hijacking — a global tsc wrapper (e.g.
 * /opt/homebrew/bin/tsc) can intercept the call and return a fake "passed"
 * result with exit 0 and empty output, making the gate a no-op.
 *
 * Using the compiler API directly loads typescript from node_modules, immune to
 * PATH interference, and runs in-process (no spawn overhead).
 */
let tsLoadWarned = false

export function runTypeCheck(cwd: string, filePath: string): LspCheckResult {
  let ts: typeof import('typescript')
  try {
    // createRequire(import.meta.url) works in both ESM (tsx, dist bundle) and
    // CJS environments — unlike bare require which is undefined in ESM.
    ts = require('typescript')
  } catch (e) {
    // typescript module not available — fail-open (no diagnostics, not trustworthy).
    // Warn once so silent degradation is discoverable instead of looking like GREEN.
    if (!tsLoadWarned) {
      tsLoadWarned = true
      process.stderr.write(
        `[rivet] typecheck gate disabled: typescript module not found (${e instanceof Error ? e.message : e}). ` +
        `Install typescript (npm i typescript) to enable type-error detection.\n`,
      )
    }
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

  // Map TS API diagnostics to our Diagnostic interface.
  const diagnostics: Diagnostic[] = []
  for (const d of allDiagnostics) {
    const category = ts.DiagnosticCategory
    const severity: Diagnostic['severity'] =
      d.category === category.Error ? 'error'
      : d.category === category.Warning ? 'warning'
      : 'info'
    // Only 'error' severity matters for the gate, but we keep all for completeness.
    const file = d.file
    if (!file) continue
    const absFile = file.fileName
    // Normalize to repo-relative path for consistent filtering downstream.
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

  // Filter by filePath if not '*'
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
