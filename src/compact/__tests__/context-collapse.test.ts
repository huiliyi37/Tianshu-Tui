import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { collapseToolResult } from '../context-collapse.js'

describe('collapseToolResult', () => {
  it('returns null for small content', () => {
    assert.equal(collapseToolResult('grep', 'short', 5, 200_000), null)
  })

  it('returns null for recent results (turnAge < 2)', () => {
    assert.equal(collapseToolResult('grep', 'x'.repeat(500), 0, 200_000), null)
    assert.equal(collapseToolResult('grep', 'x'.repeat(500), 1, 200_000), null)
  })

  it('collapses grep results with file and match info', () => {
    const lines = Array.from({ length: 20 }, (_, i) =>
      `src/file${i % 5}.ts:${i}: const x = ${i}`,
    )
    const result = collapseToolResult('grep', lines.join('\n'), 5, 200_000)
    assert.notEqual(result, null)
    assert.ok(result!.summary.includes('collapsed grep'))
    assert.ok(result!.summary.includes('matches'))
    assert.ok(result!.summary.includes('files'))
    assert.ok(result!.collapsedTokens < result!.originalTokens)
  })

  it('collapses read_file results with structural info', () => {
    const content = [
      'export class Foo {',
      '  constructor() {}',
      '}',
      'export function bar() {}',
      'export async function baz() {}',
      ...Array.from({ length: 50 }, (_, i) => `  line ${i}`),
    ].join('\n')
    const result = collapseToolResult('read_file', content, 4, 200_000)
    assert.notEqual(result, null)
    assert.ok(result!.summary.includes('collapsed read_file'))
    assert.ok(result!.summary.includes('lines'))
  })

  it('collapses bash results with tail lines', () => {
    const content = Array.from({ length: 30 }, (_, i) => `Building module ${i}...`).join('\n')
    const result = collapseToolResult('bash', content, 6, 200_000)
    assert.notEqual(result, null)
    assert.ok(result!.summary.includes('collapsed bash'))
    assert.ok(result!.summary.includes('lines output'))
  })

  it('collapses write_file results', () => {
    const result = collapseToolResult('write_file', 'x'.repeat(1000), 5, 200_000)
    assert.notEqual(result, null)
    assert.ok(result!.summary.includes('collapsed write_file'))
    assert.ok(result!.summary.includes('chars written'))
  })

  it('collapses unknown tool types with generic summary', () => {
    const content = Array.from({ length: 20 }, (_, i) => `result line ${i}`).join('\n')
    const result = collapseToolResult('custom_tool', content, 5, 200_000)
    assert.notEqual(result, null)
    assert.ok(result!.summary.includes('collapsed custom_tool'))
    assert.ok(result!.summary.includes('Preview'))
  })

  it('achieves significant compression ratio', () => {
    const lines = Array.from({ length: 100 }, (_, i) =>
      `src/components/Widget${i}.tsx:${i * 10}: export const Widget${i} = () => <div>Widget ${i}</div>`,
    )
    const content = lines.join('\n')
    const result = collapseToolResult('grep', content, 5, 200_000)!
    assert.ok(result.collapsedTokens / result.originalTokens < 0.1, 'should achieve >90% compression')
  })

  it('handles search tool same as grep', () => {
    const content = 'src/a.ts:1: hello\nsrc/b.ts:2: world\n' + 'x'.repeat(200)
    const result = collapseToolResult('search', content, 4, 200_000)
    assert.notEqual(result, null)
    assert.ok(result!.summary.includes('collapsed search'))
  })

  // T7 layering: preserve artifact references so request-layer folding does not
  // become a recall blind spot.
  it('preserves an [artifact:id] reference in the collapsed summary', () => {
    const content = `[artifact:read_file:abc12345] big file summary\n${'x'.repeat(500)}`
    const result = collapseToolResult('read_file', content, 5, 200_000)
    assert.notEqual(result, null)
    assert.match(result!.summary, /read_section artifact:read_file:abc12345/)
    // The recall hint stays inside the bracketed collapsed marker.
    assert.ok(result!.summary.endsWith(']'))
  })

  it('leaves the summary unchanged when there is no artifact reference', () => {
    const content = 'plain bash output\n' + 'x'.repeat(500)
    const result = collapseToolResult('bash', content, 5, 200_000)
    assert.notEqual(result, null)
    assert.doesNotMatch(result!.summary, /artifact:/)
  })

  it('does not duplicate an artifact reference already present in the summary', () => {
    // generic collapse includes a content preview, which itself contains the marker
    const content = `[artifact:bash:dup99] line one\nline two\nline three\n${'x'.repeat(300)}`
    const result = collapseToolResult('custom_tool', content, 5, 200_000)
    assert.notEqual(result, null)
    const occurrences = (result!.summary.match(/bash:dup99/g) ?? []).length
    assert.equal(occurrences, 1, 'reference must not be appended twice')
  })
})
