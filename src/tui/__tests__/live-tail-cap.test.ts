import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { capLiveTail } from '../live-tail-cap.js'

describe('capLiveTail', () => {
  it('returns text unchanged when within cap', () => {
    const text = 'line1\nline2\nline3'
    assert.equal(capLiveTail(text, 80, 10), text)
  })

  it('keeps only the last N display rows when over cap', () => {
    const text = Array.from({ length: 20 }, (_, i) => `line${i}`).join('\n')
    const out = capLiveTail(text, 80, 5)
    const rows = out.split('\n')
    assert.equal(rows.length, 5)
    assert.equal(rows[4], 'line19')
  })

  it('counts wrapped rows: a line wider than width costs multiple rows', () => {
    const wide = 'x'.repeat(200) // at width 80 → 3 display rows
    const text = `${wide}\nshort`
    const out = capLiveTail(text, 80, 2)
    assert.ok(out.endsWith('short'))
    assert.ok(out.length < text.length, 'must have trimmed the wide line by display rows')
  })

  it('maxRows <= 0 returns empty', () => {
    assert.equal(capLiveTail('anything', 80, 0), '')
  })
})
