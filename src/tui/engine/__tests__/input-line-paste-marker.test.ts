import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { InputLine } from '../input-line.js'

describe('InputLine · paste marker', () => {
  it('folds large paste (≥3 lines) into a [paste #N] marker', () => {
    const line = new InputLine()
    const largePaste = 'line1\nline2\nline3\nline4'
    line.insertText(largePaste)
    assert.match(line.value, /\[paste #1 \+3 lines\]/)
    assert.equal(line.value.includes('line1'), false, 'raw paste content should not be in value')
  })

  it('folds large single-line paste (≥150 chars) into a marker', () => {
    const line = new InputLine()
    const largePaste = 'x'.repeat(160)
    line.insertText(largePaste)
    assert.match(line.value, /\[paste #1 160 chars\]/)
  })

  it('does NOT fold short pastes (<3 lines, <150 chars)', () => {
    const line = new InputLine()
    const shortPaste = 'hello world'
    line.insertText(shortPaste)
    assert.equal(line.value, 'hello world')
    assert.doesNotMatch(line.value, /\[paste/)
  })

  it('increments paste id for each folded paste', () => {
    const line = new InputLine()
    line.insertText('a\nb\nc')
    line.insertText('d\ne\nf')
    assert.match(line.value, /\[paste #1/)
    assert.match(line.value, /\[paste #2/)
  })

  it('getResolvedValue() restores original paste content from markers', () => {
    const line = new InputLine()
    const paste = 'multi\nline\npaste\ncontent'
    line.insertText('prefix ')
    line.insertText(paste)
    line.insertText(' suffix')
    const resolved = line.getResolvedValue()
    assert.equal(resolved, `prefix ${paste} suffix`)
  })

  it('expandPasteAtCursor() expands marker under cursor to original content', () => {
    const line = new InputLine()
    const paste = 'expanded\ncontent\nhere'
    line.insertText(paste)
    // cursor is right after the marker
    const markerLen = line.value.length
    // Move cursor to middle of marker
    line.setValue(line.value, Math.floor(markerLen / 2))
    const expanded = line.expandPasteAtCursor()
    assert.equal(expanded, true)
    assert.equal(line.value, paste)
  })

  it('expandPasteAtCursor() returns false when cursor is not on a marker', () => {
    const line = new InputLine()
    line.insertText('hello world')
    line.setValue(line.value, 2)
    assert.equal(line.expandPasteAtCursor(), false)
  })

  it('markers are cleared after submit', () => {
    let submitted = ''
    const line = new InputLine({
      onSubmit: (text) => { submitted = text },
    })
    line.insertText('a\nb\nc\nd')
    // Trigger submit
    line.handleKey('return', '', false, false)
    // After submit, getResolvedValue should have no unresolved markers
    // (clearAfterSubmit clears pastes)
    assert.equal(line.value, '')
  })

  it('getResolvedValue() with no pastes returns value unchanged', () => {
    const line = new InputLine()
    line.insertText('just plain text')
    assert.equal(line.getResolvedValue(), 'just plain text')
  })

  it('paste marker at non-zero cursor position inserts correctly', () => {
    const line = new InputLine()
    line.insertText('before ')
    // cursor at end of "before "
    line.insertText('long\npaste\ncontent\nhere')
    line.insertText(' after')
    const resolved = line.getResolvedValue()
    assert.equal(resolved, 'before long\npaste\ncontent\nhere after')
  })
})
