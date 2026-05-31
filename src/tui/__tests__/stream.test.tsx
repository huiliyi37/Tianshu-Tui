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
 * Catches accidental regression to the pre-S7 inline cursor pattern
 * and verifies the waiting indicator for empty-text streaming state.
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

  it('shows "Waiting for model…" when streaming but no text (empty-text fallback)', () => {
    // After P0 fix: StreamOutput must not return null when isStreaming && !text.
    // It must render a waiting indicator so users don't perceive the UI as frozen.
    const lines = source.split('\n')
    const waitingLineIdx = lines.findIndex(l => l.includes('Waiting for model'))
    assert.ok(waitingLineIdx >= 0, 'source must contain "Waiting for model" fallback text')

    // Verify the waiting indicator is inside the isStreaming branch
    const waitingLine = lines[waitingLineIdx]!
    assert.ok(
      waitingLine.includes('Waiting for model'),
      'waiting indicator text must be present',
    )

    // Verify the structural pattern: if (!text) { if (isStreaming) { … } return null }
    const bangTextIdx = lines.findIndex(l => l.includes('if (!text)'))
    assert.ok(bangTextIdx >= 0, 'source must contain if (!text) guard')
    const streamingGuardAfter = lines.slice(bangTextIdx, waitingLineIdx + 1).some(l => l.includes('isStreaming'))
    assert.ok(streamingGuardAfter, 'isStreaming check must follow the !text guard')
  })

  it('still returns null when NOT streaming and no text', () => {
    // Regression guard: the early return null must still exist for idle state
    const lines = source.split('\n')
    const returnNullLines = lines.filter(l => l.trim() === 'return null')
    assert.ok(returnNullLines.length >= 1, 'source must still return null for idle empty-text state')
  })
})
