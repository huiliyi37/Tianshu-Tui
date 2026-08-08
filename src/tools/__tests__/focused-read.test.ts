import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { buildFocusedReadView } from '../focused-read.js'

describe('buildFocusedReadView', () => {
  const source = [
    "import { readFile } from 'node:fs/promises'",
    '',
    'export function unrelatedHelper(input: string): string {',
    '  return input.repeat(20)',
    '}',
    '',
    'export async function dispatchGalaxy(request: Request): Promise<Response> {',
    '  await verifyClaims(request)',
    '  return fanOut(request)',
    '}',
    '',
    'function verifyClaims(request: Request): void {',
    '  if (!request) throw new Error(\'missing request\')',
    '}',
    '',
    'export function unrelatedTail(): number {',
    '  return 42',
    '}',
  ].join('\n')

  it('returns high-signal ranges instead of the whole source body', () => {
    const result = buildFocusedReadView({
      filePath: 'src/galaxy.ts',
      content: source,
      focus: 'Galaxy dispatch verify claims fan out',
      maxChars: 2_000,
      contextLines: 1,
    })

    assert.equal(result.matched, true)
    assert.match(result.content, /\[focused-read\] src\/galaxy\.ts/)
    assert.match(result.content, /dispatchGalaxy/)
    assert.match(result.content, /verifyClaims/)
    assert.match(result.content, /Only the ranges below are selected evidence/)
    assert.match(result.content, /omitted \d+ source lines/)
    assert.ok(!result.content.includes('return 42'), 'unrelated tail body should not enter focused context')
    assert.ok(result.matchedLines < source.split('\n').length)
  })

  it('falls back to an explicit structural outline when there is no match', () => {
    const result = buildFocusedReadView({
      filePath: 'src/galaxy.ts',
      content: source,
      focus: 'nonexistent database migration symbol',
      maxChars: 1_200,
    })

    assert.equal(result.matched, false)
    assert.match(result.content, /No direct focus match\. Structural outline only/)
    assert.match(result.content, /dispatchGalaxy|unrelatedHelper/)
    assert.ok(!result.content.includes('return input.repeat(20)'))
  })
})
