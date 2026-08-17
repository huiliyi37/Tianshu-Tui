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
    assert.ok(stripAnsi(lines[0]!).includes('│'))
    assert.ok(stripAnsi(lines[0]!).includes('─'))
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
    // Selected should have > prefix
    assert.ok(lines.some(l => stripAnsi(l).includes('>')))
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

  // height=15 → maxItems = 15-5 = 10. Keep-in-view must follow selectedIndex
  // so a selection past the first page stays on screen (Ctrl+P /resume bug).
  const manyCommands = Array.from({ length: 40 }, (_, i) => ({
    label: `/c${String(i).padStart(2, '0')}`,
    description: `d${i}`,
  }))

  it('first page shows /c00 and not /c20', () => {
    const lines = renderCommandPalette(
      { commands: manyCommands, selectedIndex: 0 },
      60, 15, theme,
    ).map(stripAnsi)
    const body = lines.join('\n')
    assert.ok(body.includes('/c00'), 'first command visible at top')
    assert.ok(!body.includes('/c20'), 'command past viewport not shown')
  })

  it('selectedIndex past viewport stays visible and keeps the cursor', () => {
    const lines = renderCommandPalette(
      { commands: manyCommands, selectedIndex: 12 },
      60, 15, theme,
    ).map(stripAnsi)
    const selectedLine = lines.find(l => l.includes('/c12'))
    assert.ok(selectedLine, 'selected /c12 is in the viewport')
    assert.ok(selectedLine!.includes('>'), 'cursor sits on the selected row')
    assert.ok(!lines.some(l => l.includes('/c00')), '/c00 scrolled off')
  })

  it('selectedIndex at the last item pins the window to the end', () => {
    const lines = renderCommandPalette(
      { commands: manyCommands, selectedIndex: 39 },
      60, 15, theme,
    ).map(stripAnsi)
    assert.ok(lines.some(l => l.includes('/c39')), 'last command visible')
    assert.ok(!lines.some(l => l.includes('/c00')), 'first command scrolled off at end')
  })

  it('footer shows overflow counts when the list is taller than the viewport', () => {
    const atTop = renderCommandPalette(
      { commands: manyCommands, selectedIndex: 0 },
      60, 15, theme,
    ).map(stripAnsi)
    const footerTop = atTop[atTop.length - 2]!
    assert.ok(/↓:\d+/.test(footerTop), `↓:N overflow when more items below, got ${footerTop}`)
    assert.ok(!/↑:\d+/.test(footerTop), 'no ↑:N overflow at top')

    const atBottom = renderCommandPalette(
      { commands: manyCommands, selectedIndex: 39 },
      60, 15, theme,
    ).map(stripAnsi)
    const footerBottom = atBottom[atBottom.length - 2]!
    assert.ok(/↑:\d+/.test(footerBottom), `↑:N overflow when more items above, got ${footerBottom}`)
    assert.ok(!/↓:\d+/.test(footerBottom), 'no ↓:N overflow at end')
  })

  it('↑ inside a scrolled viewport keeps the window still', () => {
    // Window already starts at 10 (items 10..19). selected=12 is inside it, so
    // ↑ must move the cursor only — not re-pin the selection to the last row.
    const lines = renderCommandPalette(
      { commands: manyCommands, selectedIndex: 12, scrollOffset: 10 },
      60, 15, theme,
    ).map(stripAnsi)
    assert.ok(lines.some(l => l.includes('/c10')), 'window stays at previous start')
    assert.ok(!lines.some(l => l.includes('/c03')), 'does not jump back to pin-to-bottom')
    const selectedLine = lines.find(l => l.includes('/c12'))
    assert.ok(selectedLine?.includes('>'), 'cursor stays on /c12')
    assert.equal(lines.filter(l => l.includes('>')).length, 1, 'exactly one cursor')
  })

  it('out-of-range selectedIndex still highlights the last command', () => {
    const lines = renderCommandPalette(
      { commands: manyCommands, selectedIndex: 99 },
      60, 15, theme,
    ).map(stripAnsi)
    const last = lines.find(l => l.includes('/c39'))
    assert.ok(last?.includes('>'), 'clamps highlight onto the last item')
  })

  it('empty command list does not throw and has no cursor', () => {
    const lines = renderCommandPalette(
      { commands: [], selectedIndex: 0 },
      60, 15, theme,
    ).map(stripAnsi)
    assert.ok(lines.some(l => l.includes('命令面板')))
    assert.ok(!lines.some(l => /^\s*>/.test(l) || l.includes('> /') || l.trimStart().startsWith('>')), 'no selection cursor')
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
    assert.ok(secondLine && stripAnsi(secondLine).includes('>'), '选中行有 > 游标')
    assert.ok(firstLine && !stripAnsi(firstLine).includes('>'), '未选中行无游标')
  })

  it('footer 不展示恢复提示（2026-07-25 降可见性：功能保留，文案退场）', () => {
    const data: ChronicleData = { entries: [{ index: 1, time: 'a', summary: 's', current: false, id: 'x' }] }
    const lines = renderChronicle(data, 80, 20, theme)
    assert.ok(!lines.some(l => stripAnsi(l).includes('恢复')), 'footer 不含恢复会话提示')
  })
})
