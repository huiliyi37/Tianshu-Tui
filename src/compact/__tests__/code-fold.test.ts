import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { foldCode } from '../code-fold.js'

// ─── Helpers ───

/** Pad a string with enough lines to exceed MIN_LINES_TO_FOLD (50). */
function padToMinLines(code: string): string {
  const lineCount = code.split('\n').length
  if (lineCount >= 50) return code
  const padding = '\n'.repeat(50 - lineCount)
  return code + padding
}

// ─── Tests ───

describe('foldCode — language detection & guards', () => {
  test('short file (< 50 lines) returns wasFolded=false', () => {
    const content = 'export function foo() {\n  return 1\n}\n'
    const result = foldCode(content, { filePath: 'test.ts' })
    assert.equal(result.wasFolded, false)
    assert.equal(result.folded, content)
  })

  test('unknown language returns wasFolded=false', () => {
    const content = padToMinLines('some random text\n'.repeat(60))
    const result = foldCode(content, { filePath: 'readme.txt' })
    assert.equal(result.wasFolded, false)
    assert.equal(result.folded, content)
  })

  test('empty file returns wasFolded=false', () => {
    const result = foldCode('', { filePath: 'test.ts' })
    assert.equal(result.wasFolded, false)
  })
})

describe('foldCode — TS/JS folding', () => {
  test('folds function body to { … }', () => {
    const lines: string[] = [
      "import { foo } from './foo.js'",
      '',
      'export function bar(): number {',
      '  const x = 1',
      '  const y = 2',
      '  const z = 3',
      '  return x + y + z',
      '}',
      '',
      'export function baz(): string {',
      '  return "hello"',
      '}',
    ]
    // Pad to 50+ lines
    while (lines.length < 55) lines.push('')
    const content = lines.join('\n')
    const result = foldCode(content, { filePath: 'test.ts' })

    assert.equal(result.wasFolded, true)
    assert.ok(result.folded.includes('import { foo }'), 'import preserved')
    assert.ok(result.folded.includes('export function bar(): number {'), 'signature preserved')
    assert.ok(result.folded.includes('export function baz(): string {'), 'second signature preserved')
    assert.ok(result.folded.includes('{ … }'), 'body collapsed to placeholder')
    assert.ok(!result.folded.includes('return x + y + z'), 'function body hidden')
    assert.ok(result.foldedLines < result.originalLines, 'folded is shorter')
  })

  test('folds arrow function with const', () => {
    const lines: string[] = [
      'export const handler = (req: Request): Response => {',
      '  const body = req.body',
      '  validate(body)',
      '  transform(body)',
      '  return new Response(JSON.stringify(body))',
      '}',
    ]
    while (lines.length < 55) lines.push('')
    const content = lines.join('\n')
    const result = foldCode(content, { filePath: 'handler.ts' })

    assert.equal(result.wasFolded, true)
    assert.ok(result.folded.includes('export const handler ='), 'arrow signature preserved')
    assert.ok(result.folded.includes('{ … }'), 'body collapsed')
    assert.ok(!result.folded.includes('validate(body)'), 'body hidden')
  })

  test('preserves interface/type declarations (structural)', () => {
    const lines: string[] = [
      'export interface Config {',
      '  host: string',
      '  port: number',
      '}',
      '',
      'export type Status = "active" | "inactive"',
      '',
      'export function init(config: Config): void {',
      '  console.log(config.host)',
      '  console.log(config.port)',
      '}',
    ]
    while (lines.length < 55) lines.push('')
    const content = lines.join('\n')
    const result = foldCode(content, { filePath: 'config.ts' })

    assert.equal(result.wasFolded, true)
    // Interface body should be preserved (not folded)
    assert.ok(result.folded.includes('host: string'), 'interface body preserved')
    assert.ok(result.folded.includes('port: number'), 'interface body preserved')
    // Function body should be folded
    assert.ok(result.folded.includes('{ … }'), 'function body folded')
  })

  test('folds class with method bodies', () => {
    const lines: string[] = [
      'export class Calculator {',
      '  add(a: number, b: number): number {',
      '    return a + b',
      '  }',
      '',
      '  multiply(a: number, b: number): number {',
      '    return a * b',
      '  }',
      '}',
    ]
    while (lines.length < 55) lines.push('')
    const content = lines.join('\n')
    const result = foldCode(content, { filePath: 'calc.ts' })

    assert.equal(result.wasFolded, true)
    assert.ok(result.folded.includes('export class Calculator'), 'class signature preserved')
    assert.ok(result.folded.includes('{ … }'), 'body collapsed')
  })

  test('folds function with brace on next line', () => {
    const lines: string[] = [
      'export function multiLine()',
      '{',
      '  const a = 1',
      '  const b = 2',
      '  return a + b',
      '}',
    ]
    while (lines.length < 55) lines.push('')
    const content = lines.join('\n')
    const result = foldCode(content, { filePath: 'test.ts' })

    assert.equal(result.wasFolded, true)
    assert.ok(result.folded.includes('export function multiLine()'), 'signature preserved')
    assert.ok(result.folded.includes('{ … }'), 'body collapsed even with brace on next line')
    assert.ok(!result.folded.includes('const a = 1'), 'body hidden')
  })

  test('signatures array captures extracted signatures', () => {
    const lines: string[] = [
      'export function alpha(): void {',
      '  return',
      '}',
      '',
      'export const beta = (): number => {',
      '  return 42',
      '}',
    ]
    while (lines.length < 55) lines.push('')
    const content = lines.join('\n')
    const result = foldCode(content, { filePath: 'test.ts' })

    assert.ok(result.signatures.length >= 2, 'at least 2 signatures captured')
    assert.ok(result.signatures.some(s => s.includes('function alpha')), 'alpha signature captured')
    assert.ok(result.signatures.some(s => s.includes('const beta')), 'beta signature captured')
  })
})

describe('foldCode — Python folding', () => {
  test('folds def body by indentation', () => {
    const lines: string[] = [
      'import os',
      '',
      'def process(data):',
      '    result = []',
      '    for item in data:',
      '        result.append(transform(item))',
      '    return result',
      '',
      'def transform(item):',
      '    return item.upper()',
    ]
    while (lines.length < 55) lines.push('')
    const content = lines.join('\n')
    const result = foldCode(content, { filePath: 'script.py' })

    assert.equal(result.wasFolded, true)
    assert.ok(result.folded.includes('def process(data):'), 'def signature preserved')
    assert.ok(result.folded.includes('def transform(item):'), 'second def preserved')
    assert.ok(result.folded.includes('{ … }'), 'body collapsed')
    assert.ok(!result.folded.includes('result.append'), 'body hidden')
  })

  test('preserves @decorator', () => {
    const lines: string[] = [
      '@app.route("/")',
      'def index():',
      '    return "Hello"',
    ]
    while (lines.length < 55) lines.push('')
    const content = lines.join('\n')
    const result = foldCode(content, { filePath: 'app.py' })

    assert.ok(result.folded.includes('@app.route'), 'decorator preserved')
    assert.ok(result.folded.includes('def index():'), 'def signature preserved')
  })
})

describe('foldCode — JSON folding', () => {
  test('extracts key structure skeleton', () => {
    // Build a large but valid JSON by nesting enough data
    const items: unknown[] = []
    for (let i = 0; i < 30; i++) {
      items.push({ id: i, name: `item-${i}`, nested: { a: 1, b: 2, c: 3 } })
    }
    const obj = {
      name: 'test',
      items,
      config: { host: 'localhost', port: 3000, debug: true },
    }
    const content = JSON.stringify(obj, null, 2)
    const result = foldCode(content, { filePath: 'data.json' })

    assert.equal(result.wasFolded, true)
    assert.ok(result.foldedLines < result.originalLines, 'folded is shorter')
  })

  test('invalid JSON returns wasFolded=false', () => {
    const content = '{ this is not valid json '.repeat(20)
    const result = foldCode(content, { filePath: 'bad.json' })

    assert.equal(result.wasFolded, false)
  })
})

describe('foldCode — edge cases', () => {
  test('unmatched braces do not crash', () => {
    const lines: string[] = [
      'export function broken(): void {',
      '  if (true) {',
      '    // missing closing brace',
    ]
    while (lines.length < 55) lines.push('')
    const content = lines.join('\n')

    // Should not throw
    const result = foldCode(content, { filePath: 'broken.ts' })
    assert.ok(result.folded.length > 0, 'produced output without crashing')
  })

  test('braces inside string literals are ignored', () => {
    const lines: string[] = [
      'export function strings(): string {',
      "  const msg = 'has { and } inside'",
      '  const tmpl = `also ${has} braces`',
      '  return msg',
      '}',
    ]
    while (lines.length < 55) lines.push('')
    const content = lines.join('\n')
    const result = foldCode(content, { filePath: 'test.ts' })

    assert.equal(result.wasFolded, true)
    // The { … } placeholder should appear once for the function body
    const placeholders = result.folded.split('{ … }').length - 1
    assert.ok(placeholders >= 1, 'at least one fold placeholder')
  })
})
