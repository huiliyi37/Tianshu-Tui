import { test } from 'node:test'
import assert from 'node:assert/strict'
import { latexToBlock } from '../latex-block.js'

// latexToBlock renders display-math (frac stacking) to multi-line ANSI strings.
// Non-fraction math is delegated to latexToUnicode (single line).

test('latexToBlock: empty / non-string → empty array', () => {
  assert.deepEqual(latexToBlock(''), [])
  assert.deepEqual(latexToBlock('   '), [])
})

test('latexToBlock: non-fraction expression → single line', () => {
  const lines = latexToBlock('x^2 + y^2')
  assert.equal(lines.length, 1)
  assert.ok(lines[0]!.includes('x²'), `expected x² in "${lines[0]}"`)
})

test('latexToBlock: frac stacks numerator over denominator with a bar', () => {
  const lines = latexToBlock('\\frac{a+b}{c}')
  // A fraction produces ≥ 3 lines: numerator, bar, denominator.
  assert.ok(lines.length >= 3, `expected ≥3 lines for frac, got ${lines.length}: ${JSON.stringify(lines)}`)
  // The middle line(s) must contain the horizontal bar character ─.
  const hasBar = lines.some((l) => l.includes('─'))
  assert.ok(hasBar, `expected a bar (─) line in ${JSON.stringify(lines)}`)
})

test('latexToBlock: quadratic formula stacks with surrounding lhs alignment', () => {
  const lines = latexToBlock('x = \\frac{-b}{2a}')
  assert.ok(lines.length >= 2, `expected stacked output, got ${lines.length}`)
  // The lhs "x =" should appear on the baseline row.
  const hasLhs = lines.some((l) => l.includes('x') && l.includes('='))
  assert.ok(hasLhs, `expected "x =" in ${JSON.stringify(lines)}`)
})

test('latexToBlock: multiple top-level rows (newline-separated)', () => {
  // Two logical lines separated by a source newline.
  const lines = latexToBlock('a = 1\nb = 2')
  assert.ok(lines.length >= 2, `expected ≥2 rows, got ${lines.length}`)
})

test('latexToBlock: nested frac inside frac stacks recursively', () => {
  const lines = latexToBlock('\\frac{1}{\\frac{a}{b}}')
  // Nested fraction → more vertical lines than a flat fraction.
  assert.ok(lines.length >= 4, `expected ≥4 lines for nested frac, got ${lines.length}`)
  const hasBar = lines.some((l) => l.includes('─'))
  assert.ok(hasBar, `expected bar in nested frac ${JSON.stringify(lines)}`)
})

test('latexToBlock: delegates symbols to latexToUnicode (Greek, operators)', () => {
  const lines = latexToBlock('\\alpha + \\beta')
  assert.equal(lines.length, 1)
  assert.ok(lines[0]!.includes('α'), `expected α in "${lines[0]}"`)
  assert.ok(lines[0]!.includes('β'), `expected β in "${lines[0]}"`)
})

test('latexToBlock: trims leading/trailing blank lines', () => {
  const lines = latexToBlock('\\frac{a}{b}')
  assert.ok(lines.length >= 1)
  assert.ok(lines[0]!.trim() !== '', 'first line should not be blank')
  assert.ok(lines[lines.length - 1]!.trim() !== '', 'last line should not be blank')
})
