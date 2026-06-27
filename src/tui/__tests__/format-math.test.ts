import { test } from 'node:test'
import assert from 'node:assert/strict'
import { formatMarkdown } from '../format/markdown.js'
import { getTheme } from '../theme.js'

const theme = getTheme()

// Helper: strip ANSI escapes to get plain text
const plain = (s: string): string => s.replace(/\x1B\[[0-9;]*[a-zA-Z]/g, '')

test('formatMarkdown: inline math $...$ converted to Unicode', () => {
  const lines = formatMarkdown({ text: 'The area is $\\pi r^2$', columns: 80 }, theme)
  const joined = lines.map(plain).join(' ')
  assert.ok(joined.includes('π'), `expected π in "${joined}"`)
  assert.ok(joined.includes('r²'), `expected r² in "${joined}"`)
  // The dollar delimiters should be gone.
  assert.ok(!joined.includes('$'), `unexpected $ delimiter in "${joined}"`)
})

test('formatMarkdown: display math $$...$$ renders as stacked block', () => {
  const lines = formatMarkdown({ text: '$$\\frac{a+b}{c}$$', columns: 80 }, theme)
  // A fraction must produce multiple stacked lines.
  assert.ok(lines.length >= 2, `expected ≥2 lines for display frac, got ${lines.length}`)
  // The bar character should appear in the stacked output.
  const joined = lines.map(plain).join('\n')
  assert.ok(joined.includes('─'), `expected bar (─) in stacked output:\n${joined}`)
})

test('formatMarkdown: display math \\[...\\] renders as stacked block', () => {
  const lines = formatMarkdown({ text: '\\[\\frac{1}{2}\\]', columns: 80 }, theme)
  assert.ok(lines.length >= 2, `expected ≥2 lines for \\[ \\] frac`)
  const joined = lines.map(plain).join('\n')
  assert.ok(joined.includes('─'), `expected bar in \\[ \\] output`)
})

test('formatMarkdown: plain text without math unchanged', () => {
  const lines = formatMarkdown({ text: 'hello world', columns: 80 }, theme)
  const joined = lines.map(plain).join(' ')
  assert.ok(joined.includes('hello'))
  assert.ok(joined.includes('world'))
})

test('formatMarkdown: currency $ not treated as math', () => {
  // "$5" should not trigger math conversion.
  const lines = formatMarkdown({ text: 'It costs $5 today', columns: 80 }, theme)
  const joined = lines.map(plain).join(' ')
  assert.ok(joined.includes('$5'), `expected "$5" preserved in "${joined}"`)
})

test('formatMarkdown: Greek letters in inline math', () => {
  const lines = formatMarkdown({ text: '$\\alpha + \\beta = \\gamma$', columns: 80 }, theme)
  const joined = lines.map(plain).join(' ')
  assert.ok(joined.includes('α'), `expected α in "${joined}"`)
  assert.ok(joined.includes('β'), `expected β in "${joined}"`)
})

test('formatMarkdown: math mixed with markdown bold', () => {
  const lines = formatMarkdown({ text: '**Result**: $E = mc^2$', columns: 80 }, theme)
  const joined = lines.map(plain).join(' ')
  assert.ok(joined.includes('Result'), `expected "Result" in "${joined}"`)
  assert.ok(joined.includes('E'), `expected E in "${joined}"`)
  // mc^2 → mc²
  assert.ok(joined.includes('²'), `expected ² in "${joined}"`)
})
