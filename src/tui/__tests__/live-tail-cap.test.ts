import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { capLiveTail, displayRowsForText } from '../live-tail-cap.js'

describe('capLiveTail', () => {
  it('returns text unchanged when within cap', () => {
    const text = 'line1\nline2\nline3'
    assert.equal(capLiveTail(text, 80, 10), text)
  })

  it('keeps only the last N display rows when over cap and marks omitted head', () => {
    const text = Array.from({ length: 20 }, (_, i) => `line${i}`).join('\n')
    const out = capLiveTail(text, 80, 5)
    const rows = out.split('\n')
    assert.equal(rows.length, 5)
    assert.equal(rows[0], '… line15')
    assert.equal(rows[4], 'line19')
  })

  it('counts wrapped rows: a line wider than width costs multiple rows', () => {
    const wide = 'x'.repeat(200) // at width 80 → 3 display rows
    const text = `${wide}\nshort`
    const out = capLiveTail(text, 80, 2)
    assert.ok(out.endsWith('short'))
    assert.ok(out.length < text.length, 'must have trimmed the wide line by display rows')
    assert.ok(out.startsWith('… '), 'must signal that the live tail omitted earlier text')
  })

  it('counts CJK full-width characters by display width, not UTF-16 length', () => {
    const text = `${'你'.repeat(80)}\nshort`
    const out = capLiveTail(text, 80, 2)
    assert.equal(out, `… ${'你'.repeat(39)}\nshort`)
  })

  it('trims partial wide-character lines without splitting surrogate pairs', () => {
    const text = `${'🧪'.repeat(80)}\nshort`
    const out = capLiveTail(text, 80, 2)
    assert.equal(out, `… ${'🧪'.repeat(39)}\nshort`)
  })

  it('handles very narrow terminals while preserving the omission marker', () => {
    assert.equal(capLiveTail('abcd\nef', 1, 1), '…')
  })

  it('exports display row counting for sibling live chrome budgeting', () => {
    assert.equal(displayRowsForText(`${'你'.repeat(80)}\nshort`, 80), 3)
  })

  it('maxRows <= 0 returns empty', () => {
    assert.equal(capLiveTail('anything', 80, 0), '')
  })
})
