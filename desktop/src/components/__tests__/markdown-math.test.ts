import { test } from 'node:test'
import assert from 'node:assert/strict'
import { unified } from 'unified'
import remarkParse from 'remark-parse'
import remarkMath from 'remark-math'
import { normalizeMathDelimiters } from '../Markdown.tsx'

// ── normalizeMathDelimiters: pure preprocessing contract ────────
// remark-math v6 only recognizes $...$ and $$\n...\n$$. This function
// normalizes \[...\], \(...\), and single-line $$...$$ to that form.

test('normalizeMathDelimiters: \\[...\\] → multiline $$ block', () => {
  const result = normalizeMathDelimiters('\\[x^2 + y^2\\]')
  assert.ok(result.includes('$$'), `expected $$ in "${result}"`)
  assert.ok(result.includes('x^2 + y^2'), `expected content preserved`)
  // Must have internal newlines for remark-math block detection.
  assert.ok(result.includes('\n'), 'expected newlines for block math')
})

test('normalizeMathDelimiters: \\(...\\) → $...$ inline', () => {
  const result = normalizeMathDelimiters('inline \\(\\alpha + \\beta\\) text')
  assert.ok(result.includes('$\\alpha + \\beta$'), `expected $...$ in "${result}"`)
  // No newlines injected — should stay inline.
  assert.ok(!result.includes('\n$$'), 'should not create block math')
})

test('normalizeMathDelimiters: single-line $$...$$ → multiline block', () => {
  const result = normalizeMathDelimiters('$$E=mc^2$$')
  // remark-math needs internal newlines to classify as block.
  assert.ok(result.includes('$$\n'), 'expected $$ followed by newline')
  assert.ok(result.includes('\n$$'), 'expected closing $$ on its own line')
  assert.ok(result.includes('E=mc^2'), 'content preserved')
})

test('normalizeMathDelimiters: already-correct $$\\n...\\n$$ unchanged', () => {
  const src = '$$\nx^2\n$$'
  assert.equal(normalizeMathDelimiters(src), src)
})

test('normalizeMathDelimiters: inline $...$ unchanged', () => {
  const src = 'The area is $\\pi r^2$ here.'
  assert.equal(normalizeMathDelimiters(src), src)
})

test('normalizeMathDelimiters: text without math unchanged', () => {
  const src = 'Hello **world** and `code`'
  assert.equal(normalizeMathDelimiters(src), src)
})

test('normalizeMathDelimiters: preserves indentation for aligned blocks', () => {
  const src = '  $$E=mc^2$$'
  const result = normalizeMathDelimiters(src)
  assert.ok(result.includes('  $$'), 'expected indentation preserved')
})

// ── Full pipeline: normalize → parse → math nodes ──────────────
// Verifies the complete contract: after normalization, remark-math
// produces the correct math/inlineMath node types.

function collectMathNodes(source: string): Array<{ type: string; value: string }> {
  const normalized = normalizeMathDelimiters(source)
  const tree = unified().use(remarkParse).use(remarkMath).parse(normalized)
  const result: Array<{ type: string; value: string }> = []

  function walk(node: any): void {
    if (node.type === 'math' || node.type === 'inlineMath') {
      result.push({ type: node.type, value: node.value })
    }
    if (node.children) {
      for (const child of node.children) walk(child)
    }
  }
  walk(tree)
  return result
}

test('pipeline: inline $...$ → inlineMath node', () => {
  const nodes = collectMathNodes('The area is $\\pi r^2$ here.')
  assert.equal(nodes.length, 1)
  assert.equal(nodes[0]!.type, 'inlineMath')
  assert.equal(nodes[0]!.value, '\\pi r^2')
})

test('pipeline: block $$...$$ → math node', () => {
  const nodes = collectMathNodes('$$\nx^2 + y^2 = r^2\n$$')
  assert.equal(nodes.length, 1)
  assert.equal(nodes[0]!.type, 'math')
  assert.ok(nodes[0]!.value.includes('x^2 + y^2'))
})

test('pipeline: single-line $$...$$ → math node (via normalization)', () => {
  const nodes = collectMathNodes('$$E=mc^2$$')
  assert.equal(nodes.length, 1)
  assert.equal(nodes[0]!.type, 'math')
  assert.ok(nodes[0]!.value.includes('mc^2'))
})

test('pipeline: \\[...\\] → math node (via normalization)', () => {
  const nodes = collectMathNodes('\\[\\frac{1}{2}\\]')
  assert.equal(nodes.length, 1)
  assert.equal(nodes[0]!.type, 'math')
})

test('pipeline: \\(...\\) → inlineMath node (via normalization)', () => {
  const nodes = collectMathNodes('Inline \\(\\alpha + \\beta\\) text.')
  assert.equal(nodes.length, 1)
  assert.equal(nodes[0]!.type, 'inlineMath')
})

test('pipeline: multiple mixed delimiters in one message', () => {
  const source = [
    'First $a^2$ then $b^2$.',
    '',
    '$$c^2 = a^2 + b^2$$',
    '',
    'And \\(\\gamma\\) inline with \\[\\delta\\] block.',
  ].join('\n')
  const nodes = collectMathNodes(source)
  // Should have: $a^2$, $b^2$ (inline), $$c^2$$ (block), \(\gamma\) (inline), \[\delta\] (block) = 5
  assert.equal(nodes.length, 5, `expected 5 math nodes, got ${nodes.length}: ${JSON.stringify(nodes)}`)
  const types = nodes.map(n => n.type)
  assert.equal(types.filter(t => t === 'inlineMath').length, 3)
  assert.equal(types.filter(t => t === 'math').length, 2)
})

test('pipeline: currency $5 NOT parsed as math', () => {
  const nodes = collectMathNodes('It costs $5 today')
  assert.equal(nodes.length, 0)
})

test('pipeline: LaTeX content preserved faithfully', () => {
  const latex = '\\sum_{i=1}^{n} \\frac{1}{i^2}'
  const nodes = collectMathNodes(`$$${latex}$$`)
  assert.equal(nodes.length, 1)
  assert.equal(nodes[0]!.value, latex)
})
