import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { slashHintMaxVisible, SLASH_HINT_MAX_VISIBLE } from '../slash-hint.js'
import { readFileSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

// TUI components are notoriously hard to test directly: hooks need an Ink
// runtime, ink-testing-library is not installed, and React.createElement
// does not call render. We assert on the source instead — see
// .rivet/knowledge/testing.md "Source assertion pattern".
//
// These tests verify the *design contract*: the file has the structural
// elements (border, header, clamp, overflow marker, theme token) that the
// panelized SlashHint commits to. If a future refactor drops one of them,
// this test catches it before the visual regression hits a user.

const __dirname = dirname(fileURLToPath(import.meta.url))
const source = readFileSync(resolve(__dirname, '../slash-hint.tsx'), 'utf-8')

describe('SlashHint: P2 panelization source contract', () => {
  it('wraps content in a round border (modal-like panel)', () => {
    assert.ok(
      source.includes('borderStyle="round"'),
      'slash-hint.tsx must declare a round border to feel like a floating panel',
    )
  })

  it('binds border color to the active theme primary token (not a literal)', () => {
    // We want theme-driven color so that switching pastel/midnight/cyberpunk
    // keeps the panel visually coherent with the rest of the UI.
    assert.ok(
      /borderColor=\{theme\.primary\}/.test(source),
      'border color must be theme.primary so themes stay consistent',
    )
    assert.ok(
      !/borderColor="(blue|cyan|green|yellow|red|magenta)"/.test(source),
      'border must not be hard-coded to a chalk color literal',
    )
  })

  it('declares a Command Palette header label', () => {
    assert.ok(
      source.includes('Command Palette'),
      'must show a "Command Palette" header so the popup reads as a panel',
    )
  })

  it('clamps visible items to a max-height bound (panel does not grow unbounded)', () => {
    assert.ok(
      /export const SLASH_HINT_MAX_VISIBLE\s*=/.test(source),
      'must export a SLASH_HINT_MAX_VISIBLE constant for the clamp',
    )
    // The clamp is applied via .slice(0, maxVisible), where maxVisible is the
    // terminal-height-aware bound (slashHintMaxVisible) capped by the constant.
    assert.ok(
      source.includes('.slice(0, maxVisible)') &&
        /maxVisible\s*=\s*slashHintMaxVisible\(/.test(source),
      'must .slice(0, maxVisible) with maxVisible from slashHintMaxVisible(rows)',
    )
  })

  it('shows an overflow marker when filtered results exceed the clamp', () => {
    assert.ok(
      /overflow\s*=\s*filtered\.length\s*-\s*visible\.length/.test(source),
      'must compute overflow = filtered.length - visible.length',
    );
    // The footer is conditional on overflow > 0
    assert.ok(
      /overflow\s*>\s*0/.test(source),
      'overflow footer must be conditional (not always rendered)',
    )
  })

  it('highlights the selected row with theme.primary + bold (not hard-coded green)', () => {
    // selected branch must use theme tokens, not chalk literals
    const selectedBlock = source.match(/const selected = i === selectedIdx[\s\S]*?\}\)/)
    assert.ok(selectedBlock, 'must have a `selected` branch per item')
    assert.ok(
      selectedBlock![0]!.includes('theme.primary') || selectedBlock![0]!.includes('theme.warning'),
      'selected row must use a theme token (primary or warning)',
    )
    assert.ok(
      !selectedBlock![0]!.includes("color='green'") &&
        !selectedBlock![0]!.includes('color="green"'),
      'selected row must not be hard-coded green',
    )
  })
})

// Root cause five: an unbounded palette + ground zone can exceed the viewport,
// tripping Ink's fullscreen re-emit which freezes a palette snapshot into
// scrollback (a "Command Palette" box stuck at the top, see
// [[resize-ghost-streaming-timer-bypass]]). slashHintMaxVisible keeps the
// palette+ground STRICTLY under terminal height on any size.
describe('slashHintMaxVisible (palette must fit under the viewport)', () => {
  it('caps at SLASH_HINT_MAX_VISIBLE on a tall terminal', () => {
    assert.equal(slashHintMaxVisible(50), SLASH_HINT_MAX_VISIBLE)
    assert.equal(slashHintMaxVisible(40), SLASH_HINT_MAX_VISIBLE)
  })

  it('shrinks the list on a short terminal so palette+ground stays under rows', () => {
    // budget = rows - GROUND(7) - PALETTE_NON_LIST(6) - 1
    assert.equal(slashHintMaxVisible(20), 6) // 20-14=6 → min(6,6)
    assert.equal(slashHintMaxVisible(18), 4) // 18-14=4
    assert.equal(slashHintMaxVisible(16), 2) // 16-14=2
  })

  it('never returns less than 1 (always shows the selected command) on a tiny terminal', () => {
    assert.equal(slashHintMaxVisible(14), 1)
    assert.equal(slashHintMaxVisible(10), 1)
    assert.equal(slashHintMaxVisible(1), 1)
    assert.equal(slashHintMaxVisible(0), 1)
  })

  it('the chosen count + ground rows never reaches the terminal height', () => {
    for (let rows = 8; rows <= 60; rows++) {
      const visible = slashHintMaxVisible(rows)
      // palette live height ≈ visible + non-list chrome; + ground must stay < rows
      // (except the degenerate floor of 1 on terminals too small to fit anything,
      //  where overflow is unavoidable and the floor is the least-bad choice).
      if (rows >= 15) {
        const liveHeight = visible + 6 /*PALETTE_NON_LIST_ROWS*/ + 7 /*GROUND_ROWS*/
        assert.ok(liveHeight < rows, `rows=${rows}: liveHeight ${liveHeight} must be < ${rows}`)
      }
    }
  })
})
