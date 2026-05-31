import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

/**
 * Source-level contract tests for StreamOutput.
 *
 * StreamOutput uses memo + Markdown (which uses hooks internally),
 * so direct render testing requires ink-testing-library. Instead we
 * verify source-code structural invariants.
 *
 * Catches accidental regression to the pre-S7 inline cursor pattern.
 */

const __dirname = dirname(fileURLToPath(import.meta.url))
const sourcePath = resolve(__dirname, '../stream.tsx')
const source = readFileSync(sourcePath, 'utf-8')

describe('StreamOutput source contracts (S7)', () => {
  it('cursor ▊ is a sibling of <Markdown>, not inlined into its text prop', () => {
    // S7 moved cursor from: <Markdown text={displayText + '▊'} />
    // to: <Markdown text={...} />\n{isStreaming && <Text>{'▊'}</Text>}
    //
    // Structural invariant: the line containing ▊ must NOT be inside
    // a <Markdown text={...} /> JSX opening tag.
    const lines = source.split('\n')
    const cursorLineIdx = lines.findIndex(l => l.includes('▊'))
    assert.ok(cursorLineIdx >= 0, 'source must contain cursor character ▊')

    const cursorLine = lines[cursorLineIdx]!

    // The cursor line should be a <Text> element, not part of a Markdown prop
    assert.ok(cursorLine.includes('<Text'), `cursor line must be a <Text> element, got: ${cursorLine.trim()}`)
    assert.ok(!cursorLine.includes('<Markdown'), `cursor must NOT be inside a <Markdown> tag, got: ${cursorLine.trim()}`)
  })

  it('Markdown and cursor share a parent with flexDirection="column"', () => {
    // Find the line with <Markdown
    const lines = source.split('\n')
    const mdLineIdx = lines.findIndex(l => l.includes('<Markdown'))
    assert.ok(mdLineIdx >= 0, 'source must contain <Markdown> component')

    // Look backwards from the Markdown line to find the parent <Box>
    // The parent should have flexDirection="column"
    let foundColumnParent = false
    for (let i = mdLineIdx - 1; i >= Math.max(0, mdLineIdx - 5); i--) {
      const line = lines[i]!
      if (line.includes('<Box') && line.includes('flexDirection="column"')) {
        foundColumnParent = true
        break
      }
    }
    assert.ok(foundColumnParent, 'Markdown and cursor must share a flexDirection="column" parent Box')
  })

  it('cursor is conditionally rendered with isStreaming guard', () => {
    const lines = source.split('\n')
    const cursorLineIdx = lines.findIndex(l => l.includes('▊'))
    assert.ok(cursorLineIdx >= 0)

    // The cursor line or the line before it should contain {isStreaming &&
    const guardLine = lines[cursorLineIdx]!.includes('isStreaming')
      ? lines[cursorLineIdx]!
      : lines[cursorLineIdx - 1]
    assert.ok(
      guardLine?.includes('isStreaming'),
      'cursor must be guarded by isStreaming condition',
    )
  })
})
