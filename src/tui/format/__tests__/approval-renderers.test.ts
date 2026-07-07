import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { formatApprovalPrompt, renderApprovalPreview } from '../approval-renderers.js'
import { getTheme } from '../../theme.js'

const theme = getTheme()
function stripAnsi(s: string): string {
  return s.replace(/\x1B\[[0-9;]*[a-zA-Z]/g, '')
}

describe('formatApprovalPrompt', () => {
  it('renders a bordered dialog with title and options', () => {
    const lines = formatApprovalPrompt({
      toolName: 'bash',
      input: { command: 'ls -la' },
      columns: 60,
    }, theme)

    const plain = lines.map(stripAnsi)
    assert.ok(plain[0]!.includes('┌'), 'top border')
    assert.ok(plain.some(l => l.includes('APPROVAL REQUIRED')), 'title')
    assert.ok(plain.some(l => l.includes('Tool: bash')), 'tool name')
    assert.ok(plain.some(l => l.includes('ls -la')), 'preview content')
    assert.ok(plain.some(l => l.includes('Approve')), 'approve option')
    assert.ok(plain.some(l => l.includes('Deny')), 'deny option')
    assert.ok(plain.some(l => l.includes('Edit')), 'edit option')
    assert.ok(plain[plain.length - 1]!.includes('└'), 'bottom border')
  })

  it('highlights the default approve option', () => {
    const lines = formatApprovalPrompt({
      toolName: 'write_file',
      input: { file_path: '/tmp/x', content: 'hello' },
      columns: 60,
    }, theme)
    const plain = lines.map(stripAnsi)
    const approveLine = plain.find(l => l.includes('Approve'))
    assert.ok(approveLine, 'approve line exists')
    assert.ok(approveLine!.includes('▶') || approveLine!.includes('→') || approveLine!.includes('*'), 'default option marked')
  })

  it('keeps long preview within dialog width', () => {
    const longCommand = 'echo ' + 'a'.repeat(120)
    const lines = formatApprovalPrompt({
      toolName: 'bash',
      input: { command: longCommand },
      columns: 60,
    }, theme)
    const widths = lines.map(l => stripAnsi(l).length)
    const maxWidth = Math.max(...widths)
    assert.ok(maxWidth <= 60, `max width ${maxWidth} <= 60`)
  })

  it('adapts to narrow terminals', () => {
    const lines = formatApprovalPrompt({
      toolName: 'bash',
      input: { command: 'ls' },
      columns: 45,
    }, theme)
    const plain = lines.map(stripAnsi)
    const widths = plain.map(l => stripAnsi(l).length)
    const maxWidth = Math.max(...widths)
    assert.ok(maxWidth <= 45, `max width ${maxWidth} <= 45`)
  })
})

describe('renderApprovalPreview', () => {
  it('renders bash command preview', () => {
    const lines = renderApprovalPreview('bash', { command: 'rm -rf /tmp/foo' }, 60, theme)
    const plain = lines.map(stripAnsi).join('\n')
    assert.ok(plain.includes('rm -rf /tmp/foo'), 'command shown')
  })
})
