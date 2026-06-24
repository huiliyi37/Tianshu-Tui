import { spawnSync } from 'node:child_process'
import { parseDiagnosticOutput, formatDiagnostics, type Diagnostic } from './diagnostics.js'

export interface LspCheckResult {
  diagnostics: Diagnostic[]
  formatted: string
  /** Whether tsc actually completed. false when killed by signal / timed out /
   *  failed to spawn — in that case `diagnostics` is partial and untrustworthy,
   *  so callers should treat the run as inconclusive (fail-open). */
  ranOk: boolean
}

export function runTypeCheck(cwd: string, filePath: string): LspCheckResult {
  const result = spawnSync('npx', ['tsc', '--noEmit', '--pretty', 'false'], {
    cwd,
    encoding: 'utf-8',
    timeout: 30_000,
    stdio: ['pipe', 'pipe', 'pipe'],
  })
  // status === null means the process was killed by a signal (e.g. SIGTERM on
  // 30s timeout); result.error is set when spawn itself failed (npx missing,
  // ENOENT…). Either way the typecheck did not run to completion.
  const ranOk = result.error == null && result.status !== null && result.signal == null
  const output = (result.stdout || '') + (result.stderr || '')

  if (result.status === 0 && !output.trim()) {
    return { diagnostics: [], formatted: '', ranOk }
  }

  const diagnostics = parseDiagnosticOutput(output, 'typescript').filter(
    d => d.file.includes(filePath) || filePath === '*',
  )
  return { diagnostics, formatted: formatDiagnostics(diagnostics), ranOk }
}

export function shouldRunDiagnostics(toolName: string, filePath?: string): boolean {
  if (toolName !== 'write_file' && toolName !== 'edit_file') return false
  if (!filePath) return false
  return /\.(ts|tsx|js|jsx)$/.test(filePath)
}
