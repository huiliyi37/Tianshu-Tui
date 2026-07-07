import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { formatToolCardLive, formatToolCard } from '../tool-card.js'
import { getTheme } from '../../theme.js'
import { buildFileDiff } from '../../../tools/edit-diff.js'

const theme = getTheme()
function stripAnsi(s: string): string {
  return s.replace(/\x1B\[[0-9;]*[a-zA-Z]/g, '')
}

describe('formatToolCardLive', () => {
  it('returns a fixed height even without output tail', () => {
    const lines = formatToolCardLive({
      toolName: 'bash',
      toolInput: { command: 'npm test' },
      outputTail: '',
      columns: 80,
      tailLines: 3,
    }, theme)
    assert.equal(lines.length, 1 + 3, 'header + fixed tail rows')
  })

  it('pads empty tail rows when output is short', () => {
    const lines = formatToolCardLive({
      toolName: 'bash',
      toolInput: { command: 'echo hi' },
      outputTail: 'hello',
      columns: 80,
      tailLines: 3,
    }, theme)
    assert.equal(lines.length, 1 + 3, 'fixed height')
    const plain = lines.map(stripAnsi)
    assert.ok(plain.some(l => l.includes('hello')), 'content visible')
  })

  it('shows only the last tailLines of output', () => {
    const output = 'line1\nline2\nline3\nline4'
    const lines = formatToolCardLive({
      toolName: 'bash',
      outputTail: output,
      columns: 80,
      tailLines: 2,
    }, theme)
    const plain = lines.map(stripAnsi)
    assert.ok(plain.some(l => l.includes('line4')), 'last line visible')
    assert.ok(!plain.some(l => l.includes('line1')), 'first line dropped')
  })

  it('renders a spinner bullet when tick is provided', () => {
    const lines = formatToolCardLive({
      toolName: 'bash',
      toolInput: { command: 'sleep 1' },
      columns: 80,
      tick: 1,
      tailLines: 3,
    }, theme)
    const header = stripAnsi(lines[0]!)
    assert.ok(header.includes('Run(sleep 1)') || header.includes('bash'), 'title present')
    assert.equal(lines.length, 1 + 3, 'fixed height with spinner')
  })
})

describe('formatToolCard — inline edit diff (write family + isDiffContent)', () => {
  it('colors an edit_file uiContent diff and shows the +N −M summary', () => {
    const diff = buildFileDiff('src/foo.ts', 'alpha\nbeta\ngamma\n', 'alpha\nBETA\ngamma\n')
    const lines = formatToolCard({
      toolName: 'edit_file',
      content: diff,
      toolInput: { file_path: 'src/foo.ts' },
      elapsedMs: 12,
    }, theme)
    const plain = lines.map(stripAnsi).join('\n')
    assert.match(plain, /diff: \+1 −1/, 'diff stat summary present')
    assert.ok(plain.includes('-beta'), 'removal line rendered')
    assert.ok(plain.includes('+BETA'), 'addition line rendered')
  })

  it('routes apply_patch output through the diff renderer', () => {
    const diff = 'diff --git a/x.txt b/x.txt\n--- a/x.txt\n+++ b/x.txt\n@@ -1 +1 @@\n-old\n+new\n'
    const lines = formatToolCard({
      toolName: 'apply_patch',
      content: diff,
      elapsedMs: 5,
    }, theme)
    const plain = lines.map(stripAnsi).join('\n')
    assert.match(plain, /diff: \+1 −1/)
  })
})
