import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { gutterGlyph, GUTTER, type GutterKind } from '../gutter.js'

describe('gutterGlyph', () => {
  it('returns a distinct glyph for each known kind, except user/assistant which share the bold bar', () => {
    const kinds: GutterKind[] = ['user', 'assistant', 'thinking', 'tool', 'system']
    const glyphs = kinds.map(gutterGlyph)
    // user and assistant share '▍'
    assert.equal(new Set(glyphs).size, 4)
  })

  it('maps known kinds to their table entry', () => {
    assert.equal(gutterGlyph('user'), GUTTER.user.glyph)
    assert.equal(gutterGlyph('thinking'), GUTTER.thinking.glyph)
    assert.equal(gutterGlyph('system'), GUTTER.system.glyph)
  })

  it('falls back to the system glyph for an unknown kind', () => {
    assert.equal(gutterGlyph('nope' as GutterKind), GUTTER.system.glyph)
  })

  it('thinking uses ┊ and tool uses │', () => {
    assert.equal(gutterGlyph('thinking'), '┊')
    assert.equal(gutterGlyph('tool'), '│')
  })
})
