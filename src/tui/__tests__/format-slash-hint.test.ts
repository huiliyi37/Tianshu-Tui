import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  filterSlashCommands,
  formatSlashHint,
  slashCompletionTarget,
  SLASH_HINT_MAX_VISIBLE,
} from '../format/slash-hint.js'
import { getTheme } from '../theme.js'

const theme = getTheme()
function stripAnsi(s: string): string {
  return s.replace(/\x1B\[[0-9;]*[a-zA-Z]/g, '')
}

const COMMANDS = [
  { name: '/help', description: 'Show all commands' },
  { name: '/compact', description: 'Compact conversation context' },
  { name: '/model list', description: 'List available models' },
  { name: '/cost', description: 'Show session cost' },
  { name: '/clear', description: 'Clear conversation' },
  { name: '/exit', description: 'Quit' },
  { name: '/verbose', description: 'Toggle verbose' },
  { name: '/review', description: 'Run code review' },
  { name: '/review max', description: 'Run full squadron review' },
]

describe('filterSlashCommands', () => {
  it('empty query returns all', () => {
    assert.equal(filterSlashCommands(COMMANDS, '').length, COMMANDS.length)
  })

  it('substring match on name', () => {
    const out = filterSlashCommands(COMMANDS, 'comp')
    assert.ok(out.some(c => c.name === '/compact'))
  })

  it('substring match on description', () => {
    const out = filterSlashCommands(COMMANDS, 'cost')
    assert.ok(out.some(c => c.name === '/cost'))
  })

  it('fuzzy subsequence match', () => {
    const out = filterSlashCommands(COMMANDS, 'hlp')
    assert.ok(out.some(c => c.name === '/help'))
  })

  it('no match returns empty', () => {
    assert.deepEqual(filterSlashCommands(COMMANDS, 'zzzzqq'), [])
  })

  it('ranks name prefix match above fuzzy/description match', () => {
    // "revi" → /review (prefix) and /review max (prefix) should beat any
    // description-only or fuzzy matches
    const out = filterSlashCommands(COMMANDS, 'revi')
    assert.equal(out[0]!.name, '/review')
    assert.equal(out[1]!.name, '/review max')
  })

  it('ranks name prefix above substring above fuzzy above description', () => {
    // query 're' → 'review' (name prefix after stripping /), 'review max' (prefix)
    const out = filterSlashCommands(COMMANDS, 're')
    assert.equal(out[0]!.name, '/review')
    assert.equal(out[1]!.name, '/review max')
  })
})

describe('formatSlashHint', () => {
  it('non-slash input returns empty', () => {
    assert.deepEqual(formatSlashHint({ input: 'hello', commands: COMMANDS }, theme), [])
  })

  it('renders selected marker on first entry + footer', () => {
    const lines = formatSlashHint({ input: '/he', commands: COMMANDS }, theme).map(stripAnsi)
    assert.ok(lines[0]!.startsWith('❯ /help'))
    assert.ok(lines[lines.length - 1]!.includes('tab complete'))
  })

  it('caps visible entries and shows scroll indicators', () => {
    const lines = formatSlashHint({ input: '/', commands: COMMANDS }, theme).map(stripAnsi)
    // 5 visible + footer (selectedIdx=0 → scrollOffset=0, no "↑ above")
    assert.equal(lines.length, SLASH_HINT_MAX_VISIBLE + 1)
    // Footer should show overflow count and navigation hints
    assert.ok(lines[lines.length - 1]!.includes(`${COMMANDS.length - SLASH_HINT_MAX_VISIBLE} more`), 'shows overflow count')
    assert.ok(lines[lines.length - 1]!.includes('↓'), 'has down scroll indicator')
  })

  it('input /revi surfaces /review at top with ❯ marker', () => {
    const lines = formatSlashHint({ input: '/revi', commands: COMMANDS }, theme).map(stripAnsi)
    assert.ok(lines.length >= 2)
    assert.ok(lines[0]!.startsWith('❯ /review'), 'first visible line should be ❯ /review')
  })

  it('no matches returns empty array', () => {
    assert.deepEqual(formatSlashHint({ input: '/zzzzqq', commands: COMMANDS }, theme), [])
  })
})

describe('slashCompletionTarget', () => {
  it('returns first filtered command', () => {
    assert.equal(slashCompletionTarget('/he', COMMANDS), '/help')
  })

  it('returns null without matches or slash prefix', () => {
    assert.equal(slashCompletionTarget('/zzzzqq', COMMANDS), null)
    assert.equal(slashCompletionTarget('he', COMMANDS), null)
  })

  it('honours selectedIdx for arrow-key navigation', () => {
    // filterSlashCommands now ranks by relevance, so we use filterSlashCommands
    // to get the expected ordering and verify selectedIdx selects within that.
    const filtered = filterSlashCommands(COMMANDS, 'comp')
    assert.ok(filtered.length >= 1)
    assert.equal(slashCompletionTarget('/comp', COMMANDS, 0), filtered[0]!.name)
    // out-of-range idx clamps to last
    assert.equal(slashCompletionTarget('/comp', COMMANDS, 99), filtered[filtered.length - 1]!.name)
  })
})

describe('formatSlashHint scroll window', () => {
  it('selectedIdx in middle shows scroll indicators above and below', () => {
    // 9 commands, maxVisible=5. Selecting index 6 (past midpoint) should show "↑ above"
    const lines = formatSlashHint({ input: '/', commands: COMMANDS, selectedIdx: 6 }, theme).map(stripAnsi)
    // Should have "↑ N above" indicator
    assert.ok(lines.some(l => l.includes('↑') && l.includes('above')), 'shows scroll-up indicator')
  })

  it('selectedIdx near bottom pins to end', () => {
    const lines = formatSlashHint({ input: '/', commands: COMMANDS, selectedIdx: 8 }, theme).map(stripAnsi)
    // Last visible command should be the last in COMMANDS (/review max)
    const visibleCmds = lines.filter(l => l.includes('/'))
    assert.ok(visibleCmds.some(l => l.includes('/review max')), 'last command visible when at bottom')
  })

  it('scrolling down moves window forward', () => {
    // At idx 0, first visible is /help. At idx 5, /help should scroll off.
    const lines0 = formatSlashHint({ input: '/', commands: COMMANDS, selectedIdx: 0 }, theme).map(stripAnsi)
    const lines5 = formatSlashHint({ input: '/', commands: COMMANDS, selectedIdx: 5 }, theme).map(stripAnsi)
    // /help visible at idx 0 but NOT at idx 5
    assert.ok(lines0.some(l => l.includes('/help')), '/help visible at top')
    assert.ok(!lines5.some(l => l.includes('/help') && !l.includes('above')), '/help scrolled off at idx 5')
  })

  it('footer shows ↵ run hint', () => {
    const lines = formatSlashHint({ input: '/he', commands: COMMANDS }, theme).map(stripAnsi)
    assert.ok(lines[lines.length - 1]!.includes('↵'), 'footer has Enter hint')
  })
})
