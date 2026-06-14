import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import stringWidth from 'string-width'
import { getTheme } from '../../theme.js'
import { renderPager } from '../overlay.js'

// stringWidth strips ANSI and measures CJK/emoji as 2 cells — exactly the
// terminal's view. Every rendered overlay line must occupy precisely `width`
// columns so the right border ┃ lands flush. Before the string-width fix,
// padLine/title/footer used `.length`, under-padding any wide-char line.
const theme = getTheme(0)

function assertAllWidth(lines: string[], width: number): void {
  for (const line of lines) {
    assert.equal(
      stringWidth(line),
      width,
      `expected width ${width}, got ${stringWidth(line)} for ${JSON.stringify(line)}`,
    )
  }
}

// Scope: this validates the padLine / formatTitleBar / formatFooter
// string-width fix (the wave2 target). renderPager feeds content lines straight
// to padLine without per-column .padEnd, so it isolates exactly the helpers we
// changed. The per-column .padEnd inside renderChronicle/Starmap/Tasks still
// measures by code units — a separate column-layout concern, tracked as a
// follow-up, not part of this wave.
describe('overlay CJK/emoji width alignment (padLine / title / footer)', () => {
  it('renderPager: CJK title + CJK/emoji content lines stay exactly width wide', () => {
    const width = 40
    const lines = renderPager(
      { content: '天枢成熟度优化\n你好世界🛡\nascii line', page: 0, title: '会话编年史' },
      width,
      10,
      theme,
    )
    assertAllWidth(lines, width)
  })

  it('renderPager: pure-ASCII content is unaffected (no regression)', () => {
    const width = 32
    const lines = renderPager(
      { content: 'line one\nline two', page: 0, title: 'Plain' },
      width,
      8,
      theme,
    )
    assertAllWidth(lines, width)
  })

  it('renderPager: empty/short lines are padded to the full width', () => {
    const width = 24
    const lines = renderPager({ content: '甲\n\nz', page: 0 }, width, 8, theme)
    assertAllWidth(lines, width)
  })
})
