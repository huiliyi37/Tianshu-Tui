import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import chalk from 'chalk'
import { formatUserMessage } from '../format/user-message.js'
import { formatAssistantMessage } from '../format/assistant-message.js'
import { getTheme } from '../theme.js'

const theme = getTheme()

describe('formatUserMessage', () => {
  it('renders gutter marker + content without separator', () => {
    const lines = formatUserMessage({ content: 'hello', width: 40 }, theme)
    assert.ok(lines.length >= 1, 'at least 1 line')
    const plainLine0 = lines[0]!.replace(/\x1B\[[0-9;]*[a-zA-Z]/g, '')
    const useAscii = chalk.level < 3
    const expectedMarker = useAscii ? '❯' : '▌'
    assert.ok(plainLine0.includes(expectedMarker))
    assert.ok(plainLine0.includes('hello'))
  })

  it('handles multi-line content', () => {
    const lines = formatUserMessage({ content: 'line1\nline2', width: 40 }, theme)
    assert.ok(lines.some(l => l.includes('line1')))
    assert.ok(lines.some(l => l.includes('line2')))
  })

  it('body text is neutral, not the cinnabar accent (no wall of color)', () => {
    const hexTheme = { ...theme, userColor: '#d4453a' }
    const lines = formatUserMessage({ content: 'hello', width: 40 }, hexTheme)
    const line0 = lines[0]!
    const markerIndex = line0.indexOf(chalk.level < 3 ? '❯' : '▌')
    const afterMarker = line0.slice(markerIndex + 1)
    assert.ok(!/\x1B\[38;2;212;69;58m/.test(afterMarker), 'body must not be cinnabar')
  })
})

describe('formatAssistantMessage', () => {
  it('renders gutter + content', () => {
    const lines = formatAssistantMessage({ content: 'response', width: 40 }, theme)
    assert.ok(lines.length >= 1)
    const plainLine0 = lines[0]!.replace(/\x1B\[[0-9;]*[a-zA-Z]/g, '')
    const useAscii = chalk.level < 3
    const expectedMarker = useAscii ? '*' : '·'
    assert.ok(plainLine0.includes(expectedMarker))
    assert.ok(plainLine0.includes('response'))
  })

  it('returns empty for falsy content', () => {
    assert.deepEqual(formatAssistantMessage({ content: '', width: 40 }, theme), [])
    assert.deepEqual(formatAssistantMessage({ content: '  ', width: 40 }, theme), [])
  })

  it('shows omitted notice for long content', () => {
    const longContent = Array.from({ length: 250 }, (_, i) => `line ${i}`).join('\n')
    const lines = formatAssistantMessage({ content: longContent, width: 40 }, theme)
    assert.ok(lines.some(l => l.includes('omitted')))
  })

  it('caps display to last 200 lines', () => {
    const longContent = Array.from({ length: 250 }, (_, i) => `line ${i}`).join('\n')
    const lines = formatAssistantMessage({ content: longContent, width: 40 }, theme)
    const contentLines = lines.filter(l => /^line/.test(l.replace(/\x1B\[[0-9;]*[a-zA-Z]/g, '')))
    assert.ok(contentLines.length <= 200)
  })
})
