import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { capLiveTail, capLiveTailMarkdownSafe, displayRowsForText } from '../live-tail-cap.js'

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

// Regression: the live streaming view renders the tail through the markdown
// block parser, which pairs ``` fences greedily. A raw tail that starts INSIDE
// a code block makes the parser read the inherited CLOSING fence as an OPENER
// and box the following PROSE in a stray "code" frame (the offset where real
// code escapes the box is the tell). capLiveTailMarkdownSafe rebalances by
// prepending a synthetic opener when the dropped head has odd fence parity.
describe('capLiveTailMarkdownSafe (fence-aware live tail)', () => {
  const fenceCount = (s: string) => s.split('\n').filter(l => l.startsWith('```')).length

  it('leaves balanced text untouched in fence parity (even fences kept even)', () => {
    const full = 'intro\n```ts\ncode()\n```\nafter prose'
    const out = capLiveTailMarkdownSafe(full, 80, 20)
    assert.equal(fenceCount(out) % 2, 0, 'visible tail must have even fence parity')
  })

  it('prepends a synthetic opener when the tail starts inside a code block', () => {
    // 30 code lines then the closer + prose; a small window drops the opener,
    // so the tail begins inside the block (odd parity in the dropped head).
    const code = Array.from({ length: 30 }, (_, i) => `line ${i}`).join('\n')
    const full = '```ts\n' + code + '\n```\nprose after the block'
    const out = capLiveTailMarkdownSafe(full, 80, 6)
    assert.ok(out.startsWith('```\n'), 'must prepend a synthetic ``` opener to realign fences')
    assert.equal(fenceCount(out) % 2, 0, 'with the synthetic opener the tail is balanced')
  })

  it('does NOT prepend when the tail starts in prose (even dropped-head parity)', () => {
    const head = Array.from({ length: 20 }, (_, i) => `prose ${i}`).join('\n')
    const full = '```ts\nx()\n```\n' + head // balanced block, then lots of prose
    const out = capLiveTailMarkdownSafe(full, 80, 4)
    assert.ok(!out.startsWith('```'), 'prose-only tail must not get a stray fence')
  })

  it('keeps the result within maxRows even after prepending the opener', () => {
    const code = Array.from({ length: 40 }, (_, i) => `c${i}`).join('\n')
    const full = '```\n' + code // unclosed block (still streaming)
    const out = capLiveTailMarkdownSafe(full, 80, 5)
    assert.ok(out.startsWith('```\n'), 'mid-block stream tail gets the opener')
    assert.ok(displayRowsForText(out, 80) <= 5, 'opener + tail must still fit maxRows')
  })

  it('maxRows <= 0 returns empty', () => {
    assert.equal(capLiveTailMarkdownSafe('```\ncode', 80, 0), '')
  })
})
