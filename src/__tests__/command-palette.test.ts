import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { filterCommands, type PaletteCommand } from '../tui/command-palette.js'

const COMMANDS: PaletteCommand[] = [
  { name: 'compact', description: 'Compact context' },
  { name: 'model', description: 'Switch model' },
  { name: 'cockpit', description: 'Open cockpit panel' },
  { name: 'clear', description: 'Clear conversation' },
  { name: 'context', description: 'Show context usage' },
]

describe('filterCommands', () => {
  it('returns all for empty query', () => {
    assert.equal(filterCommands(COMMANDS, '').length, 5)
  })

  it('filters by prefix', () => {
    const result = filterCommands(COMMANDS, 'co')
    assert.deepEqual(result.map(r => r.name), ['cockpit', 'compact', 'context', 'clear'])
  })

  it('fuzzy matches by subsequence', () => {
    const result = filterCommands(COMMANDS, 'cpt')
    assert.ok(result.some(r => r.name === 'compact'))
  })

  it('matches description', () => {
    const result = filterCommands(COMMANDS, 'switch')
    assert.equal(result[0]!.name, 'model')
  })
})
