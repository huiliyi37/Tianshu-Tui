import { isAbsolute, relative, join } from 'node:path'
import { statSync, readFileSync } from 'node:fs'
import { runTypeCheck, type LspCheckResult } from '../lsp/client.js'
import type { Diagnostic } from '../lsp/diagnostics.js'

/**
 * Deterministic, session-independent typecheck backstop for the review gate.
 *
 * The post-edit `syntaxCheck` (esbuild) and the tsx test runner share an
 * esbuild engine that only transpiles — it never type-checks, so duplicate
 * object keys, duplicate interface members, impossible comparisons and
 * dangling references from accidental deletions all slip through. LSP
 * diagnostics would catch them but are gated on a live tsserver, which
 * worker/headless sessions (`lspManager: null`) lack.
 *
 * This module runs a single real `tsc --noEmit`, scoped to the files the task
 * actually changed, so it works the same in every session type. It is purely
 * advisory: it only ever escalates on the PRESENCE of errors in changed files,
 * and fails open (returns null) whenever tsc could not run to completion.
 */

/** A bash command that runs a real TypeScript type check (vs. a plain test run,
 *  which under tsx/esbuild never type-checks). Used to clear the
 *  typecheck-reminder flag. Narrower than self-verify's VERIFY_BASH_RE on
 *  purpose — `test`/`lint`/`build` do not establish type safety. */
export const TYPECHECK_CMD_RE = /\b(tsc|type-?check)\b/i

/** Injectable so tests can mock without spawning a real tsc / needing mkdtemp.
 *  Async so the real tsc subprocess (runTypeCheck) does not block the event loop
 *  — see client.ts. Mock runners must return a Promise. */
export type TypecheckRunner = (cwd: string) => Promise<LspCheckResult>

const defaultRunner: TypecheckRunner = (cwd) => runTypeCheck(cwd, '*')

/** Master switch. The review-gate typecheck backstop is on by default; set
 *  RIVET_TYPECHECK_GATE=0/false/off/no to disable it entirely. */
export function typecheckGateEnabled(): boolean {
  const v = process.env.RIVET_TYPECHECK_GATE
  if (v == null) return true
  return !/^(0|false|off|no)$/i.test(v.trim())
}

/** Sub-switch for the repo-wide (cross-file drift) detection layer. On by
 *  default; set RIVET_TYPECHECK_REPO_WIDE=0/false/off/no to disable only the
 *  drift layer (scoped detection remains active). */
export function repoWideEnabled(): boolean {
  const v = process.env.RIVET_TYPECHECK_REPO_WIDE
  if (v == null) return true
  return !/^(0|false|off|no)$/i.test(v.trim())
}

export interface RepoWideErrors {
  /** file -> capped list of error summaries, same format as byFile. */
  byFile: Record<string, string[]>
  /** Total count of drift errors (before capping). */
  count: number
  /** Summary text for the drift segment. */
  summary: string
}

export interface ChangedFilesTypecheck {
  /** Changed files that have at least one type error. */
  brokenFiles: string[]
  /** file -> capped list of error summaries (e.g. "L264 TS1117: ..."). */
  byFile: Record<string, string[]>
  /** Single-line text for focusHint / advisory / content note. */
  summary: string
  /** Cross-file drift errors (new errors in non-changed files). */
  repoWide?: RepoWideErrors
}

const MAX_FILES = 8
const MAX_ERRORS_PER_FILE = 5

/**
 * Normalize a tsc-reported diagnostic path to a repo-relative POSIX path.
 * tsc may print relative (`src/agent/foo.ts`) or absolute paths depending on
 * tsconfig / environment, so we relativize against cwd before matching.
 */
function normalizeDiagFile(cwd: string, file: string): string {
  const rel = isAbsolute(file) ? relative(cwd, file) : file
  return rel.split('\\').join('/')
}

/** Stable signature for a diagnostic, used to match against the baseline set.
 *  Format: `file|line|message` — file is normalized to repo-relative POSIX.
 *  Exported so the baseline script uses the exact same signing logic. */
export function errorSignature(cwd: string, d: Diagnostic): string {
  return `${normalizeDiagFile(cwd, d.file)}|${d.line}|${d.message}`
}

/** Load the accepted-debt baseline from `.rivet/typecheck-baseline.json`.
 *  Returns a Set of error signatures. Missing or corrupt file → empty Set
 *  (strict: any error escalates). */
function loadTypecheckBaseline(cwd: string): ReadonlySet<string> {
  try {
    const raw = readFileSync(join(cwd, '.rivet', 'typecheck-baseline.json'), 'utf-8')
    const arr = JSON.parse(raw)
    if (!Array.isArray(arr)) return new Set()
    return new Set(arr.filter((x): x is string => typeof x === 'string'))
  } catch {
    return new Set()
  }
}

/**
 * Run a scoped typecheck and report type errors that land in `changedFiles`.
 *
 * Also detects cross-file drift: new errors (not in baseline) that land in
 * non-changed files — the "changed schema.ts but the error surfaces in
 * default.ts" pattern. These are collected into `repoWide`.
 *
 * Returns null (no escalation) when:
 *   - no changed file is a .ts/.tsx (nothing to check)
 *   - tsc did not run to completion (crash / timeout) — fail-open
 *   - no new (non-baseline) error exists anywhere
 */
export async function runChangedFilesTypecheck(
  cwd: string,
  changedFiles: readonly string[],
  run: TypecheckRunner = defaultRunner,
  baseline: ReadonlySet<string> = loadTypecheckBaseline(cwd),
): Promise<ChangedFilesTypecheck | null> {
  const rel = changedFiles.filter(f => !isAbsolute(f) && /\.(ts|tsx)$/.test(f))
  if (rel.length === 0) return null

  const res = await run(cwd)
  // tsc crashed or timed out → partial output is untrustworthy; never escalate.
  if (!res.ranOk) return null

  const byFile: Record<string, string[]> = {}
  const driftByFile: Record<string, string[]> = {}
  let driftCount = 0
  const useRepoWide = repoWideEnabled()

  for (const d of res.diagnostics) {
    if (d.severity !== 'error') continue
    // Baseline-suppressed errors are accepted debt — skip entirely.
    if (baseline.has(errorSignature(cwd, d))) continue

    const nf = normalizeDiagFile(cwd, d.file)
    const hit = rel.find(f => nf === f || nf.endsWith('/' + f))
    if (hit) {
      const entry = (byFile[hit] ??= [])
      if (entry.length < MAX_ERRORS_PER_FILE) {
        entry.push(`L${d.line} ${d.message}`)
      }
    } else if (useRepoWide) {
      driftCount++
      const entry = (driftByFile[nf] ??= [])
      if (entry.length < MAX_ERRORS_PER_FILE) {
        entry.push(`L${d.line} ${d.message}`)
      }
    }
  }

  const brokenFiles = Object.keys(byFile)
  const driftFiles = Object.keys(driftByFile)

  if (brokenFiles.length === 0 && driftFiles.length === 0) return null

  // Scoped summary
  const parts: string[] = []
  if (brokenFiles.length > 0) {
    const shown = brokenFiles.slice(0, MAX_FILES)
    const segs = shown.map(f => {
      const errs = byFile[f]!
      const more = errs.length >= MAX_ERRORS_PER_FILE ? ' (+more)' : ''
      return `${f}: ${errs.join('; ')}${more}`
    })
    const overflow = brokenFiles.length > MAX_FILES ? ` (+${brokenFiles.length - MAX_FILES} more files)` : ''
    parts.push(`Typecheck broken in changed files — ${segs.join(' | ')}${overflow}`)
  }

  // Drift summary
  let repoWide: RepoWideErrors | undefined
  if (driftFiles.length > 0) {
    const shown = driftFiles.slice(0, MAX_FILES)
    const segs = shown.map(f => {
      const errs = driftByFile[f]!
      const more = errs.length >= MAX_ERRORS_PER_FILE ? ' (+more)' : ''
      return `${f}: ${errs.join('; ')}${more}`
    })
    const overflow = driftFiles.length > MAX_FILES ? ` (+${driftFiles.length - MAX_FILES} more files)` : ''
    const driftSummary = `cross-file 类型漂移（疑似你改的定义引发下游）— ${segs.join(' | ')}${overflow}`
    parts.push(driftSummary)
    repoWide = { byFile: driftByFile, count: driftCount, summary: driftSummary }
  }

  return { brokenFiles, byFile, summary: parts.join(' || '), repoWide }
}

// ── Memoization ────────────────────────────────────────────────────────────
// A single deliver_task RED → fix-nothing → deliver_task retry must not pay for
// a second full tsc. We cache the last result per cwd, keyed by a signature of
// the changed files' mtime+size so any real edit between calls invalidates it.
// When a file can't be stat'd (mock paths in tests, deleted file) we return
// null signature → no memo, run fresh — never a stale escalation.

interface MemoEntry { sig: string; result: ChangedFilesTypecheck | null }
const memoByCwd = new Map<string, MemoEntry>()

function changedFilesSignature(cwd: string, tsFiles: string[]): string | null {
  if (tsFiles.length === 0) return null
  try {
    return tsFiles
      .slice()
      .sort()
      .map(f => {
        const st = statSync(isAbsolute(f) ? f : join(cwd, f))
        return `${f}:${st.mtimeMs}:${st.size}`
      })
      .join('|')
  } catch {
    return null // missing/unstattable file → cannot memo safely
  }
}

/** Memoized wrapper for the review-gate call sites. Pure callers (tests) should
 *  use {@link runChangedFilesTypecheck} directly. */
export async function runChangedFilesTypecheckMemo(
  cwd: string,
  changedFiles: readonly string[],
  run: TypecheckRunner = defaultRunner,
  baseline: ReadonlySet<string> = loadTypecheckBaseline(cwd),
): Promise<ChangedFilesTypecheck | null> {
  const tsFiles = changedFiles.filter(f => !isAbsolute(f) && /\.(ts|tsx)$/.test(f))
  const sig = changedFilesSignature(cwd, tsFiles)
  if (sig) {
    const hit = memoByCwd.get(cwd)
    if (hit && hit.sig === sig) return hit.result
  }
  const result = await runChangedFilesTypecheck(cwd, changedFiles, run, baseline)
  if (sig) memoByCwd.set(cwd, { sig, result })
  return result
}

/** Test-only: clear the memo cache. */
export function __clearTypecheckMemo(): void {
  memoByCwd.clear()
}
