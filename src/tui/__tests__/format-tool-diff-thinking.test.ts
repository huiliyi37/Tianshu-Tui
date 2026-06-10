import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { formatToolCard } from '../format/tool-card.js'
import { formatDiff } from '../format/diff.js'
import { formatThinking } from '../format/thinking.js'
import { getTheme } from '../theme.js'

const theme = getTheme()
function stripAnsi(s: string): string {
  return s.replace(/\x1B\[[0-9;]*[a-zA-Z]/g, '')
}

describe('formatToolCard', () => {
  it('renders header with tool glyph and verb', () => {
    const lines = formatToolCard({ toolName: 'bash', content: 'output' }, theme)
    assert.ok(lines.length >= 2)
    assert.ok(stripAnsi(lines[0]!).includes('⚡'))
    assert.ok(stripAnsi(lines[0]!).includes('exec'))
  })

  it('renders content with border pipe', () => {
    const lines = formatToolCard({ toolName: 'grep', content: 'match1\nmatch2' }, theme)
    assert.ok(lines.some(l => stripAnsi(l).includes('│')))
    assert.ok(lines.some(l => stripAnsi(l).includes('match1')))
  })

  it('uses error color for isError', () => {
    const lines = formatToolCard({ toolName: 'bash', content: 'fail', isError: true }, theme)
    // Error header should contain ANSI escape sequences (color is applied)
    const headerAnsi = lines[0] ?? ''
    assert.ok(/\x1B\[3[0-9]/.test(headerAnsi) || /\x1B\[1m/.test(headerAnsi), 'has ANSI SGR codes')
  })

  it('shows tree connector for depth > 0', () => {
    const lines = formatToolCard({ toolName: 'read_file', content: 'data', depth: 2 }, theme)
    assert.ok(stripAnsi(lines[0]!).includes('├─'))
  })

  it('truncates to maxLines', () => {
    const long = Array.from({ length: 50 }, (_, i) => `line ${i}`).join('\n')
    const lines = formatToolCard({ toolName: 'bash', content: long, maxLines: 10 }, theme)
    assert.ok(lines.some(l => stripAnsi(l).includes('omitted')))
  })

  it('shows elapsed when not streaming', () => {
    const lines = formatToolCard({ toolName: 'bash', content: 'done', elapsedMs: 1500 }, theme)
    assert.ok(stripAnsi(lines[0]!).includes('1.5s'))
  })

  it('shows streaming indicator', () => {
    const lines = formatToolCard({ toolName: 'bash', content: '...', streaming: true }, theme)
    assert.ok(stripAnsi(lines[0]!).includes('…'))
  })

  it('shows rawPath when not truncated', () => {
    const lines = formatToolCard({ toolName: 'write_file', content: 'ok', rawPath: '/tmp/foo.ts' }, theme)
    assert.ok(lines.some(l => stripAnsi(l).includes('foo.ts')))
  })
})

describe('formatDiff', () => {
  it('renders diff with summary header', () => {
    const lines = formatDiff({ content: '+added\n-removed\n unchanged' }, theme)
    assert.ok(stripAnsi(lines[0]!).includes('+1'))
    assert.ok(stripAnsi(lines[0]!).includes('−1'))
  })

  it('colors add lines with success color', () => {
    const lines = formatDiff({ content: '+new line' }, theme)
    const addLine = lines.find(l => {
      const plain = stripAnsi(l)
      return plain.startsWith('+') && !plain.startsWith('diff:')
    })
    assert.ok(addLine, 'finds add line')
    assert.ok(/\x1B\[/.test(addLine!), 'add line has ANSI color')
  })

  it('colors del lines with error color', () => {
    const lines = formatDiff({ content: '-old line' }, theme)
    const delLine = lines.find(l => {
      const plain = stripAnsi(l)
      return plain.startsWith('-') && !plain.startsWith('diff:')
    })
    assert.ok(delLine, 'finds del line')
    assert.ok(/\x1B\[/.test(delLine!), 'del line has ANSI color')
  })

  it('truncates long diffs', () => {
    const long = Array.from({ length: 60 }, (_, i) => `line ${i}`).join('\n')
    const lines = formatDiff({ content: long, maxLines: 30 }, theme)
    assert.ok(lines.some(l => stripAnsi(l).includes('hidden')))
  })
})

describe('formatThinking', () => {
  it('returns empty when not streaming', () => {
    const lines = formatThinking({ text: 'thinking', elapsedMs: 5000, isStreaming: false }, theme)
    assert.deepEqual(lines, [])
  })

  it('shows status line when streaming', () => {
    const lines = formatThinking({ text: 'thinking…', elapsedMs: 5000, isStreaming: true }, theme)
    assert.ok(lines[0]!.includes('Thinking…'))
    assert.ok(lines[0]!.includes('5s'))
  })

  it('shows expanded content when expanded', () => {
    const lines = formatThinking({
      text: 'line1\nline2\nline3',
      elapsedMs: 5000,
      isStreaming: true,
      expanded: true,
    }, theme)
    assert.ok(lines.some(l => stripAnsi(l).includes('line1')))
  })

  it('shows long think message after 3 minutes', () => {
    const lines = formatThinking({ text: '…', elapsedMs: 200_000, isStreaming: true }, theme)
    assert.ok(stripAnsi(lines[0]!).includes('Ctrl+C'))
  })
})
