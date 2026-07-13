import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { formatApprovalPrompt, renderApprovalPreview } from '../approval-renderers.js'
import { getTheme } from '../../theme.js'

const theme = getTheme()
function stripAnsi(s: string): string {
  return s.replace(/\x1B\[[0-9;]*[a-zA-Z]/g, '')
}

describe('formatApprovalPrompt', () => {
  it('renders inline prompt with tool name and options', () => {
    const lines = formatApprovalPrompt({
      toolName: 'bash',
      input: { command: 'ls -la' },
      columns: 60,
    }, theme)

    const plain = lines.map(stripAnsi)
    // No modal box borders in subtle style
    assert.ok(!plain[0]!.includes('┌'), 'no top border in subtle style')
    assert.ok(plain.some(l => l.includes('bash')), 'tool name shown')
    assert.ok(plain.some(l => l.includes('ls -la')), 'preview content')
    assert.ok(plain.some(l => l.includes('approve')), 'approve option')
    assert.ok(plain.some(l => l.includes('deny')), 'deny option')
    assert.ok(plain.some(l => l.includes('edit')), 'edit option')
  })

  it('fits within column width', () => {
    const lines = formatApprovalPrompt({
      toolName: 'write_file',
      input: { file_path: '/tmp/x', content: 'hello world' },
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
    // prompt line (last line) may be slightly wider; main content lines should fit within columns
    const plainLines = lines.map(stripAnsi)
    const mainLines = plainLines.slice(0, -1)
    if (mainLines.length > 0) {
      const mainMax = Math.max(...mainLines.map(l => l.length))
      assert.ok(mainMax <= 45, `main lines max width ${mainMax} <= 45`)
    }
  })
})

describe('renderApprovalPreview', () => {
  it('renders bash command preview', () => {
    const lines = renderApprovalPreview('bash', { command: 'rm -rf /tmp/foo' }, 60, theme)
    const plain = lines.map(stripAnsi).join('\n')
    assert.ok(plain.includes('rm -rf /tmp/foo'), 'command shown')
  })
})
