import { spawnSync } from 'node:child_process'
import { parseDiagnosticOutput, formatDiagnostics, type Diagnostic } from './diagnostics.js'

export interface LspCheckResult {
  diagnostics: Diagnostic[]
  formatted: string
}

export function runTypeCheck(cwd: string, filePath: string): LspCheckResult {
  const result = spawnSync('npx', ['tsc', '--noEmit', '--pretty', 'false'], {
    cwd,
    encoding: 'utf-8',
    timeout: 30_000,
    stdio: ['pipe', 'pipe', 'pipe'],
  })
  const output = (result.stdout || '') + (result.stderr || '')

  if (result.status === 0 && !output.trim()) {
    return { diagnostics: [], formatted: '' }
  }

  const diagnostics = parseDiagnosticOutput(output, 'typescript').filter(
    d => d.file.includes(filePath) || filePath === '*',
  )
  return { diagnostics, formatted: formatDiagnostics(diagnostics) }
}

export function shouldRunDiagnostics(toolName: string, filePath?: string): boolean {
  if (toolName !== 'write_file' && toolName !== 'edit_file') return false
  if (!filePath) return false
  return /\.(ts|tsx|js|jsx)$/.test(filePath)
}
