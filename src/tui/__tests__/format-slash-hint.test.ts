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

  it('caps visible entries and shows overflow count', () => {
    const lines = formatSlashHint({ input: '/', commands: COMMANDS }, theme).map(stripAnsi)
    // 5 visible + footer
    assert.equal(lines.length, SLASH_HINT_MAX_VISIBLE + 1)
    assert.ok(lines[lines.length - 1]!.includes(`… ${COMMANDS.length - SLASH_HINT_MAX_VISIBLE} more`))
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
