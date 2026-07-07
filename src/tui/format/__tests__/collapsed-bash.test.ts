import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  formatCollapsedBashGroup,
  formatCollapsedBashGroupLive,
  type CollapsedBashGroup,
} from '../collapsed-bash.js'
import { getTheme } from '../../theme.js'

const theme = getTheme()
function stripAnsi(s: string): string {
  return s.replace(/\x1B\[[0-9;]*[a-zA-Z]/g, '')
}

function makeGroup(entries: CollapsedBashGroup['entries']): CollapsedBashGroup {
  return { entries, startMs: Date.now() - 1200 }
}

describe('formatCollapsedBashGroup', () => {
  it('renders collapsed state with tree-style border', () => {
    const group = makeGroup([
      { id: '1', command: 'ls -la', completed: true, content: 'a\nb', startMs: Date.now() - 1000 },
      { id: '2', command: 'pwd', completed: true, content: '/home', startMs: Date.now() - 500 },
      { id: '3', command: 'whoami', completed: true, content: 'user', startMs: Date.now() - 100 },
      { id: '4', command: 'date', completed: true, content: 'now', startMs: Date.now() - 50 },
    ])

    const lines = formatCollapsedBashGroup({ group, expanded: false, theme, columns: 80 }).map(stripAnsi)
    assert.ok(lines[0]!.includes('▶'), 'collapsed indicator')
    assert.ok(lines[0]!.includes('Ran 4 shell commands'), 'summary')
    assert.ok(lines.some(l => l.includes('│')), 'left border')
    assert.ok(lines.some(l => l.includes('╰─')), 'tree connector')
  })

  it('renders expanded state with nested tree connectors', () => {
    const group = makeGroup([
      { id: '1', command: 'ls -la', completed: true, content: 'a\nb', startMs: Date.now() - 1000 },
      { id: '2', command: 'pwd', completed: true, content: '/home', startMs: Date.now() - 500 },
    ])

    const lines = formatCollapsedBashGroup({ group, expanded: true, theme, columns: 80 }).map(stripAnsi)
    assert.ok(lines[0]!.includes('▼'), 'expanded indicator')
    assert.ok(lines.some(l => l.includes('├─')), 'middle connector')
    assert.ok(lines.some(l => l.includes('╰─')), 'last connector')
    assert.ok(lines.some(l => l.includes('ls -la')), 'first command')
    assert.ok(lines.some(l => l.includes('pwd')), 'last command')
  })

  it('shows failed marker on error entries', () => {
    const group = makeGroup([
      { id: '1', command: 'bad', completed: true, isError: true, content: 'error', startMs: Date.now() - 1000 },
    ])
    const lines = formatCollapsedBashGroup({ group, expanded: true, theme, columns: 80 }).map(stripAnsi)
    assert.ok(lines.some(l => l.includes('✗')), 'error marker')
  })

  it('shows tail stderr preview for failed entries (not just the marker)', () => {
    const group = makeGroup([
      {
        id: '1',
        command: 'npm run build',
        completed: true,
        isError: true,
        content: 'compiling...\nsome noise\nError: build failed at step 3',
        startMs: Date.now() - 1000,
      },
    ])
    const lines = formatCollapsedBashGroup({ group, expanded: true, theme, columns: 80 }).map(stripAnsi)
    assert.ok(
      lines.some(l => l.includes('Error: build failed at step 3')),
      'failed command shows its tail stderr, not a silent card',
    )
  })
})

describe('formatCollapsedBashGroupLive', () => {
  it('renders active summary line', () => {
    const group = makeGroup([
      { id: '1', command: 'ls', completed: true, content: 'ok', startMs: Date.now() - 1000 },
    ])
    const lines = formatCollapsedBashGroupLive(group, theme, 80).map(stripAnsi)
    assert.ok(lines[0]!.includes('Ran 1 shell command'), 'live summary')
  })
})
