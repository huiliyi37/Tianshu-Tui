import { test } from 'node:test'
import assert from 'node:assert/strict'
import { runTypeCheck, filterDiagnosticsForEdit } from '../client.js'
import type { LspDiagnostic } from '../manager.js'

function diag(line0: number, severity: 1 | 2, message = 'boom'): LspDiagnostic {
  return {
    range: { start: { line: line0, character: 0 }, end: { line: line0, character: 1 } },
    severity,
    message,
  }
}

/**
 * Smoke test: verify require('typescript') loads and the compiler API pipeline
 * runs to completion in the current environment (tsx for tests, bundled dist
 * for production). If this fails (ranOk=false), the typecheck gate silently
 * becomes a no-op — every delivery gets a false GREEN.
 *
 * This is the ONLY test that exercises the real runTypeCheck path (all
 * typecheck-gate tests inject a mock runner). Without it, a require resolution
 * failure in the bundled dist would go undetected until production.
 */
test('runTypeCheck: require(typescript) loads and returns ranOk=true', async () => {
  const res = await runTypeCheck(process.cwd(), '*')
  assert.equal(res.ranOk, true, 'tsc must run to completion — if ranOk is false, require(typescript) failed to load')
  // A clean repo has 0 errors, but the key assertion is ranOk, not the count.
  assert.ok(Array.isArray(res.diagnostics), 'diagnostics must be an array')
})

test('runTypeCheck: diagnostics have valid structure when present', async () => {
  const res = await runTypeCheck(process.cwd(), '*')
  if (!res.ranOk) return // can't check structure if tsc didn't run
  for (const d of res.diagnostics) {
    assert.ok(typeof d.file === 'string', `diagnostic file must be string, got ${typeof d.file}`)
    assert.ok(typeof d.line === 'number', `diagnostic line must be number, got ${typeof d.line}`)
    assert.ok(typeof d.message === 'string', `diagnostic message must be string, got ${typeof d.message}`)
  }
})

test('filterDiagnosticsForEdit: empty diagnostics → empty texts', () => {
  const r = filterDiagnosticsForEdit([], [{ start: 1, end: 5 }])
  assert.equal(r.modelText, '')
  assert.equal(r.uiText, '')
})

test('filterDiagnosticsForEdit: in-region errors and warnings surface fully', () => {
  const diags = [diag(9, 1, 'type error'), diag(11, 2, 'unused var')] // lines 10, 12
  const r = filterDiagnosticsForEdit(diags, [{ start: 10, end: 12 }])
  assert.ok(r.modelText.includes('ERROR L10: type error'))
  assert.ok(r.modelText.includes('WARNING L12: unused var'))
  assert.ok(!r.modelText.includes('elsewhere'))
})

test('filterDiagnosticsForEdit: out-of-region errors collapse to one nudge line', () => {
  const diags = [diag(9, 1, 'local'), diag(199, 1, 'far1'), diag(299, 1, 'far2')] // lines 10, 200, 300
  const r = filterDiagnosticsForEdit(diags, [{ start: 10, end: 10 }])
  assert.ok(r.modelText.includes('ERROR L10: local'), 'in-region error kept full')
  assert.ok(!r.modelText.includes('far1'), 'out-of-region error message not dumped')
  assert.ok(r.modelText.includes('+2 error(s) elsewhere in file'), 'collapsed count')
  assert.ok(r.modelText.includes('L200') && r.modelText.includes('L300'), 'lists line numbers')
  assert.ok(r.modelText.includes('run typecheck'), 'nudge to typecheck')
})

test('filterDiagnosticsForEdit: out-of-region warnings are dropped from model, kept in UI', () => {
  const diags = [diag(199, 2, 'far warning')] // line 200
  const r = filterDiagnosticsForEdit(diags, [{ start: 10, end: 10 }])
  assert.equal(r.modelText, '', 'no model output for a lone out-of-region warning')
  assert.ok(r.uiText.includes('WARNING L200: far warning'), 'UI still shows it')
})

test('filterDiagnosticsForEdit: no ranges → whole-file model output (fallback)', () => {
  const diags = [diag(9, 1, 'a'), diag(199, 1, 'b')]
  const r = filterDiagnosticsForEdit(diags, undefined)
  assert.ok(r.modelText.includes('ERROR L10: a'))
  assert.ok(r.modelText.includes('ERROR L200: b'), 'both surfaced when unlocalized')
  assert.ok(!r.modelText.includes('elsewhere'))
})

test('filterDiagnosticsForEdit: ±context includes near-boundary diagnostics', () => {
  const diags = [diag(12, 1, 'boundary')] // line 13, range ends at 10 → within +3
  const r = filterDiagnosticsForEdit(diags, [{ start: 10, end: 10 }], 3)
  assert.ok(r.modelText.includes('ERROR L13: boundary'), 'line 13 is within 10+3 context')
  assert.ok(!r.modelText.includes('elsewhere'))
})

test('filterDiagnosticsForEdit: ignores info/hint severities', () => {
  const info: LspDiagnostic = {
    range: { start: { line: 9, character: 0 }, end: { line: 9, character: 1 } },
    severity: 3,
    message: 'info',
  }
  const r = filterDiagnosticsForEdit([info], [{ start: 10, end: 10 }])
  assert.equal(r.modelText, '')
  assert.equal(r.uiText, '')
})
