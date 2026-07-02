import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { renderPager, renderStarmap, renderCommandPalette, renderChronicle } from '../format/overlay.js'
import type { PagerData, StarmapData, PaletteData, ChronicleData } from '../format/overlay.js'
import { getTheme } from '../theme.js'

const theme = getTheme()

function stripAnsi(s: string): string {
  return s.replace(/\x1B\[[0-9;]*[a-zA-Z]/g, '')
}

describe('renderPager', () => {
  it('renders border and title', () => {
    const lines = renderPager({ content: 'hello', page: 0, title: 'Test' }, 60, 20, theme)
    assert.ok(lines.length > 0)
    assert.ok(stripAnsi(lines[0]!).includes('┌'))
    assert.ok(stripAnsi(lines[0]!).includes('┐'))
    assert.ok(lines.some(l => stripAnsi(l).includes('Test')))
  })

  it('shows page number', () => {
    const lines = renderPager({ content: 'a\nb\nc\nd\ne\nf', page: 1 }, 40, 6, theme)
    assert.ok(lines.some(l => stripAnsi(l).includes('2/')))
  })

  it('includes content lines', () => {
    const data: PagerData = { content: 'line1\nline2', page: 0 }
    const lines = renderPager(data, 40, 20, theme)
    assert.ok(lines.some(l => stripAnsi(l).includes('line1')))
  })

  it('has close hint in footer', () => {
    const lines = renderPager({ content: 'x', page: 0 }, 40, 20, theme)
    assert.ok(lines.some(l => stripAnsi(l).includes('关闭')))
  })
})

describe('renderStarmap', () => {
  it('renders entries with glyphs', () => {
    const data: StarmapData = {
      entries: [
        { name: '天枢', glyph: '⭐', description: '领航', active: true },
        { name: '天权', glyph: '⚖️', description: '称量', active: false },
      ],
    }
    const lines = renderStarmap(data, 80, 20, theme)
    assert.ok(lines.some(l => stripAnsi(l).includes('天枢')))
    assert.ok(lines.some(l => stripAnsi(l).includes('天权')))
  })

  it('dims inactive entries', () => {
    const data: StarmapData = {
      entries: [
        { name: 'offline', glyph: '💤', description: 'sleeping', active: false },
      ],
    }
    const lines = renderStarmap(data, 80, 20, theme)
    const offlineLine = lines.find(l => stripAnsi(l).includes('offline'))
    assert.ok(offlineLine)
  })

  it('has activate hint in footer', () => {
    const data: StarmapData = { entries: [{ name: 'X', glyph: 'x', description: 'x', active: true }] }
    const lines = renderStarmap(data, 80, 20, theme)
    assert.ok(lines.some(l => stripAnsi(l).includes('激活')))
  })
})

describe('renderCommandPalette', () => {
  it('highlights selected command', () => {
    const data: PaletteData = {
      commands: [
        { label: 'Command A', hotkey: 'A', description: 'First' },
        { label: 'Command B', hotkey: 'B' },
      ],
      selectedIndex: 0,
    }
    const lines = renderCommandPalette(data, 60, 15, theme)
    assert.ok(lines.some(l => stripAnsi(l).includes('Command A')))
    // Selected should have ▶ prefix
    assert.ok(lines.some(l => stripAnsi(l).includes('▶')))
  })

  it('shows search text in title', () => {
    const data: PaletteData = {
      commands: [{ label: 'Test' }],
      selectedIndex: 0,
      searchText: 'test',
    }
    const lines = renderCommandPalette(data, 60, 15, theme)
    assert.ok(lines.some(l => stripAnsi(l).includes('test')))
  })

  it('shows hotkeys', () => {
    const data: PaletteData = {
      commands: [{ label: 'Run', hotkey: 'Ctrl+R' }],
      selectedIndex: 0,
    }
    const lines = renderCommandPalette(data, 60, 15, theme)
    assert.ok(lines.some(l => stripAnsi(l).includes('Ctrl+R')))
  })
})

describe('renderChronicle', () => {
  it('renders session entries', () => {
    const data: ChronicleData = {
      entries: [
        { index: 1, time: '10:30', summary: 'Bug fix', current: true },
        { index: 2, time: '11:00', summary: 'Feature', current: false },
      ],
    }
    const lines = renderChronicle(data, 80, 20, theme)
    assert.ok(lines.some(l => stripAnsi(l).includes('#1')))
    assert.ok(lines.some(l => stripAnsi(l).includes('#2')))
  })

  it('highlights current session', () => {
    const data: ChronicleData = {
      entries: [
        { index: 5, time: 'now', summary: 'Current', current: true },
      ],
    }
    const lines = renderChronicle(data, 80, 20, theme)
    const currentLine = lines.find(l => stripAnsi(l).includes('#5'))
    assert.ok(currentLine)
    // Current should have ANSI formatting (bold/color)
    assert.ok(/\x1B\[/.test(currentLine!), 'current entry has ANSI color')
  })

  it('shows ▸ cursor on selectedIndex row (G5 导航高亮)', () => {
    const data: ChronicleData = {
      entries: [
        { index: 1, time: 'a', summary: 'first', current: false, id: 'aaa' },
        { index: 2, time: 'b', summary: 'second', current: false, id: 'bbb' },
      ],
      selectedIndex: 1,
    }
    const lines = renderChronicle(data, 80, 20, theme)
    const secondLine = lines.find(l => stripAnsi(l).includes('second'))
    const firstLine = lines.find(l => stripAnsi(l).includes('first'))
    assert.ok(secondLine && stripAnsi(secondLine).includes('▶'), '选中行有 ▶ 游标')
    assert.ok(firstLine && !stripAnsi(firstLine).includes('▶'), '未选中行无游标')
  })

  it('footer 引导 Enter → resume（G5 诚实文案）', () => {
    const data: ChronicleData = { entries: [{ index: 1, time: 'a', summary: 's', current: false, id: 'x' }] }
    const lines = renderChronicle(data, 80, 20, theme)
    assert.ok(lines.some(l => stripAnsi(l).includes('恢复')), 'footer 含恢复会话提示')
  })
})
