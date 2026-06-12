/**
 * Wrote-but-never-read static nudge (D-fix, session 803d897d).
 *
 * Cheap, mechanical check run at deliver_task time: for symbols ADDED by the
 * pending diff (exported declarations and interface/object field names),
 * count read-side usages across the repo. A symbol that is only declared and
 * assigned — never read — is the modelOverride / banditState failure class:
 * "built but disconnected". Output is a YELLOW hint, never blocking.
 *
 * Heuristic by design: it cannot prove a read is on the production path, but
 * zero reads anywhere is mechanically certain dead wiring.
 */

import { spawnSync } from 'node:child_process'

export interface WroteButNeverReadFinding {
  symbol: string
  /** File whose diff introduced the symbol. */
  file: string
  kind: 'export' | 'field'
}

const MAX_SYMBOLS_SCANNED = 8
export const MAX_NUDGE_FINDINGS = 5

const EXPORT_RE = /^export\s+(?:declare\s+)?(?:abstract\s+)?(?:async\s+)?(?:function\*?|const|let|class|interface|type|enum)\s+([A-Za-z_$][\w$]*)/
// Indented `name?: Type` or `readonly name: Type` — interface/type/object field shape.
const FIELD_RE = /^\s{2,}(?:readonly\s+)?([A-Za-z_$][\w$]*)\??:\s*\S/

// Names too generic to grep meaningfully.
const NOISE_NAMES = new Set([
  'id', 'name', 'type', 'kind', 'value', 'data', 'key', 'path', 'file', 'files',
  'content', 'message', 'status', 'state', 'result', 'error', 'options', 'config',
  'input', 'output', 'index', 'count', 'items', 'description', 'required', 'properties',
])

function isCandidateName(name: string): boolean {
  return name.length >= 4 && !NOISE_NAMES.has(name)
}

function gitAddedLines(cwd: string, file: string): string[] {
  try {
    const diff = spawnSync('git', ['diff', 'HEAD', '--', file], { cwd, encoding: 'utf-8', timeout: 10_000 })
    if (diff.status === 0 && diff.stdout.trim()) {
      return diff.stdout
        .split('\n')
        .filter(l => l.startsWith('+') && !l.startsWith('+++'))
        .map(l => l.slice(1))
    }
    // Untracked new file: the whole content is "added".
    const tracked = spawnSync('git', ['ls-files', '--error-unmatch', '--', file], { cwd, encoding: 'utf-8', timeout: 5000 })
    if (tracked.status !== 0) {
      const cat = spawnSync('cat', [file], { cwd, encoding: 'utf-8', timeout: 5000 })
      if (cat.status === 0) return cat.stdout.split('\n')
    }
  } catch {
    // fail open — nudge is best-effort
  }
  return []
}

interface SymbolCandidate { symbol: string; file: string; kind: 'export' | 'field' }

function collectAddedSymbols(cwd: string, changedFiles: string[]): SymbolCandidate[] {
  const seen = new Set<string>()
  const exportsFound: SymbolCandidate[] = []
  const fieldsFound: SymbolCandidate[] = []
  for (const file of changedFiles) {
    if (!/\.(ts|tsx|mts|cts)$/.test(file) || /\.test\./.test(file) || file.includes('__tests__')) continue
    for (const line of gitAddedLines(cwd, file)) {
      const exp = EXPORT_RE.exec(line.trimStart())
      if (exp && isCandidateName(exp[1]!) && !seen.has(exp[1]!)) {
        seen.add(exp[1]!)
        exportsFound.push({ symbol: exp[1]!, file, kind: 'export' })
        continue
      }
      const field = FIELD_RE.exec(line)
      if (field && isCandidateName(field[1]!) && !seen.has(field[1]!)) {
        seen.add(field[1]!)
        fieldsFound.push({ symbol: field[1]!, file, kind: 'field' })
      }
    }
  }
  // Fields first: zero-read fields (modelOverride class) are the target bug;
  // exported symbols have weaker signal (might be a public API addition).
  return [...fieldsFound, ...exportsFound].slice(0, MAX_SYMBOLS_SCANNED)
}

/** A line "writes/declares" the symbol when it only appears as `sym:` or `sym =`. */
function isWriteOrDeclareOnly(line: string, symbol: string): boolean {
  const occurrences = line.split(symbol).length - 1
  if (occurrences === 0) return true
  // Count occurrences followed by `:` (declaration / object-literal write) or
  // single `=` (assignment). If ALL occurrences are writes, the line holds no read.
  const writeRe = new RegExp(`\\b${symbol}\\??\\s*(?::(?!:)|=(?![=>]))`, 'g')
  const writes = (line.match(writeRe) ?? []).length
  return writes >= occurrences
}

function hasReadSideUsage(cwd: string, symbol: string): boolean {
  try {
    const grep = spawnSync(
      'git',
      ['grep', '-n', '--untracked', '-F', symbol, '--', '*.ts', '*.tsx'],
      { cwd, encoding: 'utf-8', timeout: 10_000 },
    )
    if (grep.status !== 0 && grep.status !== 1) return true // grep failed → fail open (assume read)
    for (const hit of grep.stdout.split('\n')) {
      if (!hit) continue
      const firstColon = hit.indexOf(':')
      const secondColon = hit.indexOf(':', firstColon + 1)
      if (firstColon < 0 || secondColon < 0) continue
      const file = hit.slice(0, firstColon)
      if (/\.test\./.test(file) || file.includes('__tests__')) continue
      const text = hit.slice(secondColon + 1)
      if (text.trimStart().startsWith('//') || text.trimStart().startsWith('*')) continue
      if (!isWriteOrDeclareOnly(text, symbol)) return true
    }
    return false
  } catch {
    return true
  }
}

/**
 * Detect symbols added by the pending diff that have zero read-side usages
 * in non-test code. Capped and fail-open: an empty result means "no findings
 * or check unavailable", never blocks delivery.
 */
export function detectWroteButNeverRead(cwd: string, changedFiles: string[]): WroteButNeverReadFinding[] {
  const findings: WroteButNeverReadFinding[] = []
  for (const candidate of collectAddedSymbols(cwd, changedFiles)) {
    if (!hasReadSideUsage(cwd, candidate.symbol)) findings.push(candidate)
    if (findings.length >= MAX_NUDGE_FINDINGS) break
  }
  return findings
}

/** Render findings as YELLOW hint lines for the deliver_task report. */
export function formatWroteButNeverRead(findings: WroteButNeverReadFinding[]): string[] {
  if (findings.length === 0) return []
  const lines = ['', '⚠️ wrote-but-never-read (YELLOW, non-blocking):']
  for (const f of findings) {
    lines.push(`   ${f.symbol} (${f.kind}, added in ${f.file}) — 0 read-side consumers found. Wire a reader on the production path or remove it.`)
  }
  return lines
}
