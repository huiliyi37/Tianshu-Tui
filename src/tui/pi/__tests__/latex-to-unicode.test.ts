import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  latexToUnicode,
  renderMathInText,
  isBareMathEnvironment,
  setMathColorTrueColor,
} from '../latex-to-unicode.js'

// ── Core conversion contracts ─────────────────────────────────

test('latexToUnicode: Greek letters', () => {
  assert.equal(latexToUnicode('\\alpha + \\beta = \\gamma'), 'α + β = γ')
  // \pi followed by a literal letter renders pi + the letter (space-separated).
  const piResult = latexToUnicode('\\pi r^2')
  assert.ok(piResult.includes('π'), `expected π in "${piResult}"`)
  assert.ok(piResult.includes('r²'), `expected r² in "${piResult}"`)
})

test('latexToUnicode: superscripts and subscripts', () => {
  assert.equal(latexToUnicode('x^2 + y^2'), 'x² + y²')
  assert.equal(latexToUnicode('x_i + x_j'), 'xᵢ + xⱼ')
})

test('latexToUnicode: big operators', () => {
  const sumResult = latexToUnicode('\\sum_{i=1}^{n} x_i')
  assert.ok(sumResult.includes('∑'), `expected ∑ in "${sumResult}"`)
  assert.ok(sumResult.includes('xᵢ'), `expected xᵢ in "${sumResult}"`)
  assert.ok(latexToUnicode('\\int_0^1 f(x) dx').includes('∫₀¹'), 'expected ∫₀¹ in integral')
})

test('latexToUnicode: fractions map to vulgar or stacked form', () => {
  const result = latexToUnicode('\\frac{1}{2}')
  assert.ok(result.includes('½'), `expected ½ in "${result}"`)
})

test('latexToUnicode: relations and arrows', () => {
  assert.equal(latexToUnicode('a \\leq b'), 'a ≤ b')
  assert.equal(latexToUnicode('a \\neq b'), 'a ≠ b')
  assert.equal(latexToUnicode('x \\to y'), 'x → y')
  assert.equal(latexToUnicode('A \\Rightarrow B'), 'A ⇒ B')
})

test('latexToUnicode: unknown commands degrade without throwing', () => {
  // Unknown commands consume their {...} argument and degrade to the bare name.
  const result = latexToUnicode('\\unknowncmd{x}')
  assert.ok(result.includes('unknowncmd'), `expected bare name in "${result}"`)
  assert.ok(!result.includes('\\'), `unexpected backslash in "${result}"`)
})

// ── Prose scanning ────────────────────────────────────────────

test('renderMathInText: inline $...$ spans converted', () => {
  const result = renderMathInText('The value of $\\pi$ is about 3.14')
  assert.ok(result.includes('π'), `expected π in "${result}"`)
})

test('renderMathInText: display $$...$$ spans converted', () => {
  const result = renderMathInText('$$x^2 + y^2 = r^2$$')
  assert.ok(result.includes('x²'), `expected x² in "${result}"`)
  assert.ok(result.includes('y²'), `expected y² in "${result}"`)
})

test('renderMathInText: currency $ left untouched', () => {
  // Anti-currency heuristic: "$5 and $10" must not be treated as math.
  const result = renderMathInText('$5 and $10')
  assert.equal(result, '$5 and $10')
})

test('renderMathInText: no math delimiters → unchanged', () => {
  assert.equal(renderMathInText('hello world'), 'hello world')
})

// ── Environment detection ─────────────────────────────────────

test('isBareMathEnvironment: math envs are true', () => {
  assert.equal(isBareMathEnvironment('equation'), true)
  assert.equal(isBareMathEnvironment('align'), true)
  assert.equal(isBareMathEnvironment('align*'), true) // starred variant
})

test('isBareMathEnvironment: text envs are false', () => {
  assert.equal(isBareMathEnvironment('tabular'), false)
  assert.equal(isBareMathEnvironment('itemize'), false)
  assert.equal(isBareMathEnvironment('verbatim'), false)
})

// ── Color injection capability ────────────────────────────────

test('setMathColorTrueColor: does not throw and accepts boolean', () => {
  assert.doesNotThrow(() => setMathColorTrueColor(true))
  assert.doesNotThrow(() => setMathColorTrueColor(false))
})

test('latexToUnicode: textcolor produces ANSI escapes (256-color default)', () => {
  setMathColorTrueColor(false)
  const result = latexToUnicode('\\textcolor{red}{warning}')
  assert.ok(result.includes('\x1b['), `expected ANSI escape in "${JSON.stringify(result)}"`)
})
