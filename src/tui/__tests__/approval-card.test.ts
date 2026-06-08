import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

// Source-level contract test for the P2 panelized approval + intent cards.
// See .rivet/knowledge/testing.md — TUI components can't be rendered in unit
// tests, so we assert on source structure.

const __dirname = dirname(fileURLToPath(import.meta.url))
const appSource = readFileSync(resolve(__dirname, '../app.tsx'), 'utf-8')

// Locate the pendingIntent + pendingApproval blocks by anchoring on their
// distinct labels. This is robust against unrelated changes elsewhere.
function extractBlock(label: string): string {
  const idx = appSource.indexOf(label)
  assert.ok(idx >= 0, `app.tsx must contain the label "${label}"`)
  // The block ends at the next closing </Box> at the same nesting level.
  // We grab ~1000 chars from the label and stop at the first </Box></Box>.
  const slice = appSource.slice(idx, idx + 1500)
  return slice
}

describe('pendingIntent card: P2 panelization source contract', () => {
  const block = extractBlock('pendingIntent && (')
  // The block is `condition && (<Box>…</Box>)` — the matched `&&` opens JSX.
  const jsx = block.slice(block.indexOf('<Box'))

  it('wraps content in a round border (modal-like panel)', () => {
    assert.ok(
      jsx.includes('borderStyle="round"'),
      'pendingIntent must use a round border to feel like a panel',
    )
  })

  it('uses theme.primary (informational blue), not the previous cyan literal', () => {
    assert.ok(
      /borderColor=\{theme\.primary\}/.test(jsx),
      'pendingIntent border color must be theme.primary (informational)',
    )
    assert.ok(
      !/borderColor="cyan"/.test(jsx),
      'pendingIntent must not be hard-coded to cyan',
    )
  })

  it('has a title row header', () => {
    assert.ok(
      /Intent/.test(jsx),
      'pendingIntent must have a "Intent" title row',
    )
  })
})

describe('pendingApproval card: P2 panelization source contract', () => {
  const block = extractBlock('pendingApproval && (')
  const jsx = block.slice(block.indexOf('<Box'))

  it('wraps content in a round border (modal-like panel)', () => {
    assert.ok(
      jsx.includes('borderStyle="round"'),
      'pendingApproval must use a round border to feel like a panel',
    )
  })

  it('uses theme.warning (semantic gold), not the previous yellow literal', () => {
    assert.ok(
      /borderColor=\{theme\.warning\}/.test(jsx),
      'pendingApproval border color must be theme.warning (semantic warning)',
    )
    assert.ok(
      !/borderColor="yellow"/.test(jsx),
      'pendingApproval must not be hard-coded to yellow',
    )
  })

  it('has a title row header', () => {
    assert.ok(
      /Tool Approval/.test(jsx),
      'pendingApproval must have a "Tool Approval" title row',
    )
  })

  it('highlights the y/n keys in semantic success/error colors', () => {
    // [y] and [n] keys must use semantic theme colors (not hardcoded literals)
    assert.ok(
      /theme\.(success|primary|warning)\}[\s\S]{0,200}\[y\]/.test(jsx) || /theme\.(success|primary|warning)\}[\s\S]{0,200}y/.test(jsx),
      '[y] key must use a semantic theme color (success/primary/warning)',
    )
    assert.ok(
      /theme\.(error|dim|warning)\}[\s\S]{0,200}\[n\]/.test(jsx) || /theme\.(error|dim|warning)\}[\s\S]{0,200}n/.test(jsx),
      '[n] key must use a semantic theme color (error/dim/warning)',
    )
  })
})
