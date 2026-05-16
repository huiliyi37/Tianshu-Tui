import { execSync } from 'node:child_process'
import { parseDiagnosticOutput, formatDiagnostics, type Diagnostic } from './diagnostics.js'

export interface LspCheckResult {
  diagnostics: Diagnostic[]
  formatted: string
}

export function runTypeCheck(cwd: string, filePath: string): LspCheckResult {
  try {
    execSync('npx tsc --noEmit --pretty false 2>&1', { cwd, encoding: 'utf-8', timeout: 30_000, stdio: 'pipe' })
    return { diagnostics: [], formatted: '' }
  } catch (err: unknown) {
    const output = (err as { stdout?: string; message?: string })?.stdout
      ?? (err as { message?: string })?.message
      ?? ''
    const diagnostics = parseDiagnosticOutput(output, 'typescript').filter(
      d => d.file.includes(filePath) || filePath === '*',
    )
    return { diagnostics, formatted: formatDiagnostics(diagnostics) }
  }
}

export function shouldRunDiagnostics(toolName: string, filePath?: string): boolean {
  if (toolName !== 'write_file' && toolName !== 'edit_file') return false
  if (!filePath) return false
  return /\.(ts|tsx|js|jsx)$/.test(filePath)
}
