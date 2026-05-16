import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { parseDiagnosticOutput, formatDiagnostics } from '../lsp/diagnostics.js'

describe('parseDiagnosticOutput', () => {
  it('parses tsc output into diagnostics', () => {
    const output = `src/main.ts(10,5): error TS2304: Cannot find name 'foo'.
src/main.ts(15,3): error TS2322: Type 'string' is not assignable to type 'number'.`
    const diags = parseDiagnosticOutput(output, 'typescript')
    assert.equal(diags.length, 2)
    assert.equal(diags[0]?.file, 'src/main.ts')
    assert.equal(diags[0]?.line, 10)
    assert.equal(diags[0]?.col, 5)
    assert.equal(diags[0]?.severity, 'error')
    assert.ok(diags[0]?.message.includes('Cannot find name'))
  })

  it('parses warnings', () => {
    const output = 'src/lib.ts(3,1): warning TS6133: unused variable.'
    const diags = parseDiagnosticOutput(output, 'typescript')
    assert.equal(diags.length, 1)
    assert.equal(diags[0]?.severity, 'warning')
  })

  it('returns empty array for empty output', () => {
    assert.equal(parseDiagnosticOutput('', 'typescript').length, 0)
  })

  it('returns empty array for non-tsc output', () => {
    assert.equal(parseDiagnosticOutput('some random output\nnot a diagnostic', 'typescript').length, 0)
  })
})

describe('formatDiagnostics', () => {
  it('formats diagnostics for tool result injection', () => {
    const diags = [
      { file: 'src/a.ts', line: 5, col: 3, severity: 'error' as const, message: 'oops' },
      { file: 'src/b.ts', line: 10, col: 1, severity: 'warning' as const, message: 'unused' },
    ]
    const formatted = formatDiagnostics(diags)
    assert.ok(formatted.includes('src/a.ts:5:3'))
    assert.ok(formatted.includes('error'))
    assert.ok(formatted.includes('oops'))
    assert.ok(formatted.includes('warning'))
  })

  it('returns empty string for empty diagnostics', () => {
    assert.equal(formatDiagnostics([]), '')
  })
})
