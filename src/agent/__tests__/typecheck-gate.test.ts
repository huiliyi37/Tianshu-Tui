import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  runChangedFilesTypecheck,
  runChangedFilesTypecheckMemo,
  typecheckGateEnabled,
  repoWideEnabled,
  errorSignature,
  __clearTypecheckMemo,
  type TypecheckRunner,
} from '../typecheck-gate.js'
import type { Diagnostic } from '../../lsp/diagnostics.js'
import type { LspCheckResult } from '../../lsp/client.js'

const CWD = '/repo'

function diag(file: string, line: number, message: string, severity: Diagnostic['severity'] = 'error'): Diagnostic {
  return { file, line, col: 1, severity, message }
}

function runner(diagnostics: Diagnostic[], ranOk = true): TypecheckRunner {
  const res: LspCheckResult = { diagnostics, formatted: '', ranOk }
  return () => res
}

test('flags a changed file that has a type error', () => {
  const r = runChangedFilesTypecheck(CWD, ['src/x.ts'], runner([diag('src/x.ts', 264, 'TS1117: duplicate property')]))
  assert.ok(r)
  assert.deepEqual(r.brokenFiles, ['src/x.ts'])
  assert.match(r.summary, /Typecheck broken/)
  assert.match(r.summary, /src\/x\.ts/)
})

test('point 1: matches when tsc reports an absolute path', () => {
  const r = runChangedFilesTypecheck(CWD, ['src/x.ts'], runner([diag('/repo/src/x.ts', 10, 'TS2300: dup')]))
  assert.ok(r)
  assert.deepEqual(r.brokenFiles, ['src/x.ts'])
})

test('point 1: does not substring-misfire (src/xx.ts changed, error in src/x.ts)', () => {
  // Error in src/x.ts is drift relative to changed src/xx.ts. With baseline
  // suppressing it, scoped match must still not misfire onto src/xx.ts.
  const baseline = new Set(['src/x.ts|10|TS2300: dup'])
  const r = runChangedFilesTypecheck(CWD, ['src/xx.ts'], runner([diag('src/x.ts', 10, 'TS2300: dup')]), baseline)
  assert.equal(r, null)
})

test('point 2: ranOk=false (crash/timeout) → null even with diagnostics', () => {
  const r = runChangedFilesTypecheck(CWD, ['src/x.ts'], runner([diag('src/x.ts', 1, 'TS9999: x')], false))
  assert.equal(r, null)
})

test('errors only in untouched files with baseline suppression → null', () => {
  const r = runChangedFilesTypecheck(CWD, ['src/x.ts'], runner([diag('src/other.ts', 5, 'TS1: noise')]), new Set(['src/other.ts|5|TS1: noise']))
  assert.equal(r, null)
})

test('no .ts/.tsx among changed files → null and runner not called', () => {
  let called = false
  const spy: TypecheckRunner = () => { called = true; return { diagnostics: [], formatted: '', ranOk: true } }
  const r = runChangedFilesTypecheck(CWD, ['README.md', 'data.json'], spy)
  assert.equal(r, null)
  assert.equal(called, false)
})

test('absolute changed-file paths are filtered out before running', () => {
  let called = false
  const spy: TypecheckRunner = () => { called = true; return { diagnostics: [], formatted: '', ranOk: true } }
  const r = runChangedFilesTypecheck(CWD, ['/abs/src/x.ts'], spy)
  assert.equal(r, null)
  assert.equal(called, false)
})

test('warnings are ignored — only errors escalate', () => {
  const r = runChangedFilesTypecheck(CWD, ['src/x.ts'], runner([diag('src/x.ts', 3, 'TS6133: unused', 'warning')]))
  assert.equal(r, null)
})

test('caps errors per file and files in summary', () => {
  const ds: Diagnostic[] = []
  for (let i = 0; i < 12; i++) ds.push(diag(`src/f${i}.ts`, i, `TS${i}: e`))
  const changed = ds.map(d => d.file)
  const r = runChangedFilesTypecheck(CWD, changed, runner(ds))
  assert.ok(r)
  assert.equal(r.brokenFiles.length, 12)
  assert.match(r.summary, /\+4 more files/)
})

test('typecheckGateEnabled: default on, off via 0/false/off/no', () => {
  const prev = process.env.RIVET_TYPECHECK_GATE
  try {
    delete process.env.RIVET_TYPECHECK_GATE
    assert.equal(typecheckGateEnabled(), true)
    for (const v of ['0', 'false', 'off', 'no', 'OFF']) {
      process.env.RIVET_TYPECHECK_GATE = v
      assert.equal(typecheckGateEnabled(), false, `expected off for ${v}`)
    }
    process.env.RIVET_TYPECHECK_GATE = '1'
    assert.equal(typecheckGateEnabled(), true)
  } finally {
    if (prev == null) delete process.env.RIVET_TYPECHECK_GATE
    else process.env.RIVET_TYPECHECK_GATE = prev
  }
})

test('memo: identical changed-file set with stable mtime runs tsc once', () => {
  __clearTypecheckMemo()
  let calls = 0
  const spy: TypecheckRunner = () => { calls++; return { diagnostics: [], formatted: '', ranOk: true } }
  // Use a real, existing source file so statSync produces a stable signature.
  const files = ['src/agent/typecheck-gate.ts']
  runChangedFilesTypecheckMemo(process.cwd(), files, spy)
  runChangedFilesTypecheckMemo(process.cwd(), files, spy)
  assert.equal(calls, 1, 'second identical call should hit the memo')
})

test('memo: a different changed-file set bypasses the cache', () => {
  __clearTypecheckMemo()
  let calls = 0
  const spy: TypecheckRunner = () => { calls++; return { diagnostics: [], formatted: '', ranOk: true } }
  runChangedFilesTypecheckMemo(process.cwd(), ['src/agent/typecheck-gate.ts'], spy)
  runChangedFilesTypecheckMemo(process.cwd(), ['src/agent/loop.ts'], spy)
  assert.equal(calls, 2)
})

test('memo: unstattable (mock) paths fail open — no cache, runner runs each time', () => {
  __clearTypecheckMemo()
  let calls = 0
  const spy: TypecheckRunner = () => { calls++; return { diagnostics: [], formatted: '', ranOk: true } }
  const files = ['src/does-not-exist-xyz.ts']
  runChangedFilesTypecheckMemo('/fake/cwd', files, spy)
  runChangedFilesTypecheckMemo('/fake/cwd', files, spy)
  assert.equal(calls, 2)
})

// ── Cross-file drift detection (the 24-error class) ─────────────────────────

test('drift: error in non-changed file + empty baseline → non-null with repoWide', () => {
  const r = runChangedFilesTypecheck(CWD, ['src/schema.ts'], runner([diag('src/default.ts', 10, 'TS2322: type mismatch')]))
  assert.ok(r, 'must escalate when a new repo-wide error exists')
  assert.deepEqual(r.brokenFiles, [], 'no scoped errors — brokenFiles is empty')
  assert.ok(r.repoWide, 'repoWide segment must be populated')
  assert.equal(r.repoWide!.count, 1)
  assert.match(r.summary, /cross-file/)
  assert.match(r.summary, /src\/default\.ts/)
})

test('drift: same error in baseline → null (accepted debt)', () => {
  const sig = 'src/default.ts|10|TS2322: type mismatch'
  const r = runChangedFilesTypecheck(CWD, ['src/schema.ts'], runner([diag('src/default.ts', 10, 'TS2322: type mismatch')]), new Set([sig]))
  assert.equal(r, null, 'baseline-suppressed error must not escalate')
})

test('drift: corrupted/missing baseline → treated as empty set → strict', () => {
  // Pass no baseline (undefined) — defaults to loadTypecheckBaseline which returns empty Set
  const r = runChangedFilesTypecheck(CWD, ['src/schema.ts'], runner([diag('src/default.ts', 10, 'TS9999: boom')]))
  assert.ok(r, 'missing baseline = strict = any error escalates')
  assert.ok(r.repoWide)
  assert.equal(r.repoWide!.count, 1)
})

test('drift: RIVET_TYPECHECK_REPO_WIDE=0 → only scoped, drift errors ignored', () => {
  const prev = process.env.RIVET_TYPECHECK_REPO_WIDE
  try {
    process.env.RIVET_TYPECHECK_REPO_WIDE = '0'
    const r = runChangedFilesTypecheck(CWD, ['src/schema.ts'], runner([diag('src/default.ts', 10, 'TS1: drift')]))
    assert.equal(r, null, 'repo-wide disabled → drift error not escalated')
  } finally {
    if (prev == null) delete process.env.RIVET_TYPECHECK_REPO_WIDE
    else process.env.RIVET_TYPECHECK_REPO_WIDE = prev
  }
})

test('drift: scoped + drift both present → summary has both segments', () => {
  const r = runChangedFilesTypecheck(CWD, ['src/x.ts'], runner([
    diag('src/x.ts', 1, 'TS1: scoped'),
    diag('src/other.ts', 2, 'TS2: drift'),
  ]))
  assert.ok(r)
  assert.deepEqual(r.brokenFiles, ['src/x.ts'])
  assert.ok(r.repoWide)
  assert.equal(r.repoWide!.count, 1)
  assert.match(r.summary, /Typecheck broken in changed files/)
  assert.match(r.summary, /cross-file/)
})

test('repoWideEnabled: default on, off via 0/false/off/no', () => {
  const prev = process.env.RIVET_TYPECHECK_REPO_WIDE
  try {
    delete process.env.RIVET_TYPECHECK_REPO_WIDE
    assert.equal(repoWideEnabled(), true)
    for (const v of ['0', 'false', 'off', 'no', 'OFF']) {
      process.env.RIVET_TYPECHECK_REPO_WIDE = v
      assert.equal(repoWideEnabled(), false, `expected off for ${v}`)
    }
    process.env.RIVET_TYPECHECK_REPO_WIDE = '1'
    assert.equal(repoWideEnabled(), true)
  } finally {
    if (prev == null) delete process.env.RIVET_TYPECHECK_REPO_WIDE
    else process.env.RIVET_TYPECHECK_REPO_WIDE = prev
  }
})

// ── Signature consistency: baseline script ↔ runtime gate ───────────────────
// The baseline script and the runtime gate must produce identical signatures
// for the same diagnostic, including multi-line messages (TS2322/TS2345 which
// are the primary drift error types). If they diverge, baseline suppression
// silently fails and the escape hatch becomes useless for the exact errors
// it's meant to handle.

test('signature: single-line diagnostic matches expected format', () => {
  const d = diag('src/x.ts', 42, 'TS2304: Cannot find name')
  const sig = errorSignature(CWD, d)
  assert.equal(sig, 'src/x.ts|42|TS2304: Cannot find name')
})

test('signature: multi-line diagnostic (TS2322 type mismatch) is preserved verbatim', () => {
  // TS2322 produces multi-line messages via flattenDiagnosticMessageText with \n:
  // "Type 'string' is not assignable to type 'number'.\n  Type 'string' is not assignable to type 'number'."
  const multiLine = "Type 'string' is not assignable to type 'number'.\n  The expected type comes from property 'x' which is declared here"
  const d = diag('src/consumer.ts', 10, multiLine)
  const sig = errorSignature(CWD, d)
  assert.equal(sig, `src/consumer.ts|10|${multiLine}`, 'multi-line message must be preserved as-is in signature')
})

test('signature: same diagnostic always produces same signature (determinism)', () => {
  const d = diag('src/a.ts', 1, 'TS1: x')
  assert.equal(errorSignature(CWD, d), errorSignature(CWD, d))
})
