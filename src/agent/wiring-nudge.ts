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

import { spawnGitSync } from '../tools/spawn-git.js'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

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
    const diff = spawnGitSync(['diff', 'HEAD', '--', file], { cwd, encoding: 'utf-8', timeout: 10_000 })
    if (diff.status === 0 && diff.stdout.trim()) {
      return diff.stdout
        .split(/\r?\n/)
        .filter(l => l.startsWith('+') && !l.startsWith('+++'))
        .map(l => l.slice(1))
    }
    // Untracked new file: the whole content is "added".
    const tracked = spawnGitSync(['ls-files', '--error-unmatch', '--', file], { cwd, encoding: 'utf-8', timeout: 5000 })
    if (tracked.status !== 0) {
      // Read directly instead of spawning `cat`, which doesn't exist on native
      // Windows (the symbol scan silently returned nothing there).
      try {
        return readFileSync(resolve(cwd, file), 'utf-8').split(/\r?\n/)
      } catch {
        return []
      }
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
    const grep = spawnGitSync(
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

// ─────────────────────────────────────────────────────────────────────────────
// Dual check: read-but-never-produced (虚假绿灯 / false-green guard).
//
// The sibling of wrote-but-never-read. Catches the council modelUsed class:
// a field that production code READS/renders, but which NO production code ever
// WRITES a value to — only test fixtures assign it. Tests stay green because the
// fixture fabricates a shape the real system never produces.
//
// HONEST LIMITATION (subtype split):
//   - Subtype A (caught): field has zero value-writes in non-test code; only
//     tests assign it. Mechanically certain fixture-only data.
//   - Subtype B (NOT caught): a production write line exists but its runtime
//     condition never fires (e.g. `raw.modelUsed ? {modelUsed} : {}` where the
//     source never carries modelUsed). A grep sees the write site and stays
//     silent. Subtype B needs dataflow/wiring tests, not static grep — that's
//     why this is paired with a review-gate checklist item, not relied on alone.
// ─────────────────────────────────────────────────────────────────────────────

export interface ReadButNeverProducedFinding {
  field: string
  /** File whose diff reads the field. */
  file: string
}

// `.field` property read NOT immediately followed by `(` (excludes method calls).
const FIELD_READ_RE = /\.([A-Za-z_$][\w$]*)\b(?!\s*\()/g

/** Right-hand side of `field:` — a type annotation vs a runtime value. */
function colonRhsIsType(rhs: string): boolean {
  const t = rhs.trim()
  // Type-like: builtin types, generics, tuple/array, or PascalCase type refs.
  return /^(?:string|number|boolean|unknown|any|void|null|undefined|symbol|bigint|object|never|true|false|readonly\b|keyof\b|typeof\b|Array<|Record<|Partial<|Readonly<|Promise<|Map<|Set<|\[|\(|[A-Z])/.test(t)
}

/** Interface/type field declaration (shape), not a value write. */
function isFieldDeclaration(line: string, field: string): boolean {
  if (/\b(?:interface|type)\b/.test(line)) return true
  const m = new RegExp(`^\\s*(?:readonly\\s+)?${field}\\??:\\s*(.+)$`).exec(line)
  return m ? colonRhsIsType(m[1]!) : false
}

/** A line WRITES a runtime value to `field` (`.field = v` or object literal `field: v`). */
function isFieldValueWrite(line: string, field: string): boolean {
  if (isFieldDeclaration(line, field)) return false
  // Property assignment `.field =` (not ==, =>).
  if (new RegExp(`\\.${field}\\s*=(?![=>])`).test(line)) return true
  // Object-literal `field: <value>` where RHS is a runtime value, not a type.
  const m = new RegExp(`\\b${field}\\s*:\\s*(.+)$`).exec(line)
  if (m && !colonRhsIsType(m[1]!)) return true
  return false
}

function collectReadFields(cwd: string, changedFiles: string[]): SymbolCandidate[] {
  const seen = new Set<string>()
  const found: SymbolCandidate[] = []
  for (const file of changedFiles) {
    if (!/\.(ts|tsx|mts|cts)$/.test(file) || /\.test\./.test(file) || file.includes('__tests__')) continue
    for (const line of gitAddedLines(cwd, file)) {
      let m: RegExpExecArray | null
      FIELD_READ_RE.lastIndex = 0
      while ((m = FIELD_READ_RE.exec(line))) {
        const name = m[1]!
        if (isCandidateName(name) && !seen.has(name)) {
          seen.add(name)
          found.push({ symbol: name, file, kind: 'field' })
        }
      }
    }
  }
  return found.slice(0, MAX_SYMBOLS_SCANNED)
}

/** Classify a field's value-write sites: how many in production vs test code. */
function fieldWriteSites(cwd: string, field: string): { prod: number; test: number } {
  try {
    const grep = spawnGitSync(
      ['grep', '-n', '--untracked', '-F', field, '--', '*.ts', '*.tsx'],
      { cwd, encoding: 'utf-8', timeout: 10_000 },
    )
    // grep failed (not "no match") → fail open: pretend a prod write exists, never flag.
    if (grep.status !== 0 && grep.status !== 1) return { prod: 1, test: 0 }
    let prod = 0
    let test = 0
    for (const hit of grep.stdout.split('\n')) {
      if (!hit) continue
      const firstColon = hit.indexOf(':')
      const secondColon = hit.indexOf(':', firstColon + 1)
      if (firstColon < 0 || secondColon < 0) continue
      const file = hit.slice(0, firstColon)
      const text = hit.slice(secondColon + 1)
      if (text.trimStart().startsWith('//') || text.trimStart().startsWith('*')) continue
      if (!isFieldValueWrite(text, field)) continue
      if (/\.test\./.test(file) || file.includes('__tests__')) test++
      else prod++
    }
    return { prod, test }
  } catch {
    return { prod: 1, test: 0 } // fail open
  }
}

/**
 * Detect fields READ by the pending non-test diff that have a value-write ONLY
 * in test code (zero production writes). Mechanically certain fixture-only data
 * = false-green candidate. Capped and fail-open: never blocks delivery.
 */
export function detectReadButNeverProduced(cwd: string, changedFiles: string[]): ReadButNeverProducedFinding[] {
  const findings: ReadButNeverProducedFinding[] = []
  for (const candidate of collectReadFields(cwd, changedFiles)) {
    const sites = fieldWriteSites(cwd, candidate.symbol)
    // Subtype A: read in prod, written only in tests, never produced in prod.
    if (sites.prod === 0 && sites.test > 0) {
      findings.push({ field: candidate.symbol, file: candidate.file })
    }
    if (findings.length >= MAX_NUDGE_FINDINGS) break
  }
  return findings
}

/** Render read-but-never-produced findings as a YELLOW hint. */
export function formatReadButNeverProduced(findings: ReadButNeverProducedFinding[]): string[] {
  if (findings.length === 0) return []
  const lines = ['', '⚠️ read-but-never-produced (YELLOW, 疑似虚假绿灯 / non-blocking):']
  for (const f of findings) {
    lines.push(`   ${f.field} (read in ${f.file}) — 仅测试 fixture 赋值，生产代码无写入点。确认真实数据流写入点，否则消费是死代码。`)
  }
  return lines
}
