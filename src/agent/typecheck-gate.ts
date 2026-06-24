import { isAbsolute, relative, join } from 'node:path'
import { statSync } from 'node:fs'
import { runTypeCheck, type LspCheckResult } from '../lsp/client.js'

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

/** Injectable so tests can mock without spawning a real tsc / needing mkdtemp. */
export type TypecheckRunner = (cwd: string) => LspCheckResult

const defaultRunner: TypecheckRunner = (cwd) => runTypeCheck(cwd, '*')

/** Master switch. The review-gate typecheck backstop is on by default; set
 *  RIVET_TYPECHECK_GATE=0/false/off/no to disable it entirely. */
export function typecheckGateEnabled(): boolean {
  const v = process.env.RIVET_TYPECHECK_GATE
  if (v == null) return true
  return !/^(0|false|off|no)$/i.test(v.trim())
}

export interface ChangedFilesTypecheck {
  /** Changed files that have at least one type error. */
  brokenFiles: string[]
  /** file -> capped list of error summaries (e.g. "L264 TS1117: ..."). */
  byFile: Record<string, string[]>
  /** Single-line text for focusHint / advisory / content note. */
  summary: string
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

/**
 * Run a scoped typecheck and report type errors that land in `changedFiles`.
 *
 * Returns null (no escalation) when:
 *   - no changed file is a .ts/.tsx (nothing to check)
 *   - tsc did not run to completion (crash / timeout) — fail-open
 *   - no error lands in a changed file (clean, or only pre-existing noise
 *     in untouched files)
 */
export function runChangedFilesTypecheck(
  cwd: string,
  changedFiles: readonly string[],
  run: TypecheckRunner = defaultRunner,
): ChangedFilesTypecheck | null {
  const rel = changedFiles.filter(f => !isAbsolute(f) && /\.(ts|tsx)$/.test(f))
  if (rel.length === 0) return null

  const res = run(cwd)
  // tsc crashed or timed out → partial output is untrustworthy; never escalate.
  if (!res.ranOk) return null

  const byFile: Record<string, string[]> = {}
  for (const d of res.diagnostics) {
    if (d.severity !== 'error') continue
    const nf = normalizeDiagFile(cwd, d.file)
    const hit = rel.find(f => nf === f || nf.endsWith('/' + f))
    if (!hit) continue
    const entry = (byFile[hit] ??= [])
    if (entry.length < MAX_ERRORS_PER_FILE) {
      entry.push(`L${d.line} ${d.message}`)
    }
  }

  const brokenFiles = Object.keys(byFile)
  if (brokenFiles.length === 0) return null

  const shown = brokenFiles.slice(0, MAX_FILES)
  const segs = shown.map(f => {
    const errs = byFile[f]!
    const more = errs.length >= MAX_ERRORS_PER_FILE ? ' (+more)' : ''
    return `${f}: ${errs.join('; ')}${more}`
  })
  const overflow = brokenFiles.length > MAX_FILES ? ` (+${brokenFiles.length - MAX_FILES} more files)` : ''
  const summary = `Typecheck broken in changed files — ${segs.join(' | ')}${overflow}`

  return { brokenFiles, byFile, summary }
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
export function runChangedFilesTypecheckMemo(
  cwd: string,
  changedFiles: readonly string[],
  run: TypecheckRunner = defaultRunner,
): ChangedFilesTypecheck | null {
  const tsFiles = changedFiles.filter(f => !isAbsolute(f) && /\.(ts|tsx)$/.test(f))
  const sig = changedFilesSignature(cwd, tsFiles)
  if (sig) {
    const hit = memoByCwd.get(cwd)
    if (hit && hit.sig === sig) return hit.result
  }
  const result = runChangedFilesTypecheck(cwd, changedFiles, run)
  if (sig) memoByCwd.set(cwd, { sig, result })
  return result
}

/** Test-only: clear the memo cache. */
export function __clearTypecheckMemo(): void {
  memoByCwd.clear()
}
