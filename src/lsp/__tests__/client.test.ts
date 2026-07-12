import { test } from 'node:test'
import assert from 'node:assert/strict'
import { filterDiagnosticsForEdit } from '../client.js'
import type { LspDiagnostic } from '../manager.js'

function diag(line0: number, severity: 1 | 2, message = 'boom'): LspDiagnostic {
  return {
    range: { start: { line: line0, character: 0 }, end: { line: line0, character: 1 } },
    severity,
    message,
  }
}

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
