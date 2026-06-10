import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { formatUserMessage } from '../format/user-message.js'
import { formatAssistantMessage } from '../format/assistant-message.js'
import { getTheme } from '../theme.js'

const theme = getTheme()

describe('formatUserMessage', () => {
  it('renders separator + gutter + content', () => {
    const lines = formatUserMessage({ content: 'hello', width: 40 }, theme)
    assert.ok(lines.length >= 3, 'at least 3 lines (separator + gutter + content)')
    assert.ok(lines[0]!.includes('─'))
    assert.ok(lines[1]!.includes('▍'))
    assert.ok(lines[1]!.includes('You'))
    assert.ok(lines[2]!.includes('hello'))
  })

  it('handles multi-line content', () => {
    const lines = formatUserMessage({ content: 'line1\nline2', width: 40 }, theme)
    assert.ok(lines.some(l => l.includes('line1')))
    assert.ok(lines.some(l => l.includes('line2')))
  })
})

describe('formatAssistantMessage', () => {
  it('renders gutter + content', () => {
    const lines = formatAssistantMessage({ content: 'response', width: 40 }, theme)
    assert.ok(lines.length >= 2)
    assert.ok(lines[0]!.includes('▍'))
    assert.ok(lines[0]!.includes('Rivet'))
    assert.ok(lines[1]!.includes('response'))
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
