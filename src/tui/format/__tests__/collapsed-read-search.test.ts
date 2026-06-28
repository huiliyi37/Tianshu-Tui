import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  formatCollapsedGroup,
  formatCollapsedGroupLive,
  type CollapsedReadSearchGroup,
} from '../collapsed-read-search.js'
import { getTheme } from '../../theme.js'
import { displayWidth } from '../../width.js'

const theme = getTheme()
function stripAnsi(s: string): string {
  return s.replace(/\x1B\[[0-9;]*[a-zA-Z]/g, '')
}

function makeGroup(entries: CollapsedReadSearchGroup['entries']): CollapsedReadSearchGroup {
  return { entries, startMs: Date.now() - 1200 }
}

describe('formatCollapsedGroup', () => {
  it('renders collapsed state with tree-style border and expand hint', () => {
    const group = makeGroup([
      { id: '1', toolName: 'read_file', input: { file_path: 'src/a.ts' }, displayName: 'src/a.ts', kind: 'read', completed: true, content: 'line1\nline2' },
      { id: '2', toolName: 'read_file', input: { file_path: 'src/b.ts' }, displayName: 'src/b.ts', kind: 'read', completed: true, content: 'line1' },
      { id: '3', toolName: 'read_file', input: { file_path: 'src/c.ts' }, displayName: 'src/c.ts', kind: 'read', completed: true, content: 'line1' },
      { id: '4', toolName: 'read_file', input: { file_path: 'src/d.ts' }, displayName: 'src/d.ts', kind: 'read', completed: true, content: 'line1' },
    ])

    const lines = formatCollapsedGroup({ group, expanded: false, theme, columns: 80 }).map(stripAnsi)
    assert.ok(lines[0]!.includes('▶'), 'collapsed indicator')
    assert.ok(lines[0]!.includes('Read 4 files'), 'summary')
    assert.ok(lines.some(l => l.includes('│')), 'left border')
    assert.ok(lines.some(l => l.includes('╰─')), 'tree connector')
    assert.ok(lines.some(l => l.includes('[Ctrl+O]')), 'expand hint')
  })

  it('renders expanded state with nested tree connectors', () => {
    const group = makeGroup([
      { id: '1', toolName: 'read_file', input: { file_path: 'src/a.ts' }, displayName: 'src/a.ts', kind: 'read', completed: true, content: 'line1\nline2' },
      { id: '2', toolName: 'read_file', input: { file_path: 'src/b.ts' }, displayName: 'src/b.ts', kind: 'read', completed: true, content: 'line1' },
    ])

    const lines = formatCollapsedGroup({ group, expanded: true, theme, columns: 80 }).map(stripAnsi)
    assert.ok(lines[0]!.includes('▼'), 'expanded indicator')
    assert.ok(lines.some(l => l.includes('├─')), 'middle connector')
    assert.ok(lines.some(l => l.includes('╰─')), 'last connector')
    assert.ok(lines.some(l => l.includes('src/a.ts')), 'first entry')
    assert.ok(lines.some(l => l.includes('src/b.ts')), 'last entry')
  })

  it('shows pending hint when no entry completed', () => {
    const group = makeGroup([
      { id: '1', toolName: 'grep', input: { pattern: 'foo' }, displayName: '"foo"', kind: 'search', completed: false },
    ])
    const lines = formatCollapsedGroup({ group, expanded: false, theme, columns: 80 }).map(stripAnsi)
    assert.ok(lines.some(l => l.includes('pending')), 'pending hint')
  })

  it('truncates CJK content by display width, not byte length', () => {
    // 8 CJK chars = 16 display columns. With maxWidth ~10, content MUST be truncated.
    // Bug: .length-based check (8 > 10 → false) passes the full line through,
    // causing it to overflow the column budget.
    const cjkContent = '这是一段中文测试内容'
    const group = makeGroup([
      { id: '1', toolName: 'read_file', input: { file_path: 'src/a.ts' }, displayName: 'src/a.ts', kind: 'read', completed: true, content: cjkContent },
    ])
    // Narrow columns so the CJK line won't fit (childPrefix = '│     ' = 6 cols, columns=20 → maxWidth ≈ 14)
    const lines = formatCollapsedGroup({ group, expanded: true, theme, columns: 20 }).map(stripAnsi)
    // Every line must fit within the terminal column budget.
    for (const line of lines) {
      // CJK width: each CJK char = 2 columns.
      const w = displayWidth(line)
      assert.ok(w <= 20, `line "${line.slice(0, 20)}..." width ${w} exceeds 20 columns`)
    }
    // The CJK content line should be truncated (not the full 8-char CJK string).
    const contentLines = lines.filter(l => l.includes('中'))
    assert.ok(contentLines.length > 0, 'CJK content present')
    const contentLine = contentLines[0]!
    // After truncation, the visible text should be shorter than the original
    assert.ok(contentLine.length < cjkContent.length + 10, 'CJK content was truncated')
  })
})

describe('formatCollapsedGroupLive', () => {
  it('renders active summary line', () => {
    const group = makeGroup([
      { id: '1', toolName: 'grep', input: { pattern: 'foo' }, displayName: '"foo"', kind: 'search', completed: true, content: 'result' },
    ])
    const lines = formatCollapsedGroupLive(group, theme, 80).map(stripAnsi)
    assert.ok(lines[0]!.includes('Searched 1 pattern'), 'live summary')
  })
})
