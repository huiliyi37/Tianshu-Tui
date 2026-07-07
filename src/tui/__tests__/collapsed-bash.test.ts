/**
 * collapsed-bash 纯函数测试。
 */

import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  isCollapsibleBashCommand,
  MAX_COLLAPSIBLE_COMMAND_LEN,
  computeBashGroupStats,
  buildBashSummaryText,
  buildBashLiveSummaryText,
  formatCollapsedBashGroup,
  formatCollapsedBashGroupLive,
  CollapsedBashBuffer,
  type CollapsedBashGroup,
} from '../format/collapsed-bash.js'
import { getTheme } from '../theme.js'

const theme = getTheme()

function makeGroup(entries: Array<Partial<import('../format/collapsed-bash.js').CollapsedBashEntry>> = []): CollapsedBashGroup {
  return {
    entries: entries.map((e, i) => ({
      id: e.id ?? `id-${i}`,
      command: e.command ?? 'pwd',
      content: e.content,
      isError: e.isError,
      completed: e.completed ?? false,
      startMs: e.startMs ?? Date.now() - 1000,
    })),
    startMs: Date.now() - 1000,
  }
}

// ── Heuristics ─────────────────────────────────────────────────

describe('isCollapsibleBashCommand', () => {
  it('returns true for safe read-only commands', () => {
    assert.equal(isCollapsibleBashCommand('pwd'), true)
    assert.equal(isCollapsibleBashCommand('ls -la'), true)
    assert.equal(isCollapsibleBashCommand('cat README.md'), true)
    assert.equal(isCollapsibleBashCommand('grep TODO src/'), true)
    assert.equal(isCollapsibleBashCommand('git status'), true)
    assert.equal(isCollapsibleBashCommand('git diff --stat'), true)
    assert.equal(isCollapsibleBashCommand('sed -n "1,10p" file.ts'), true)
  })

  it('returns false for output redirection', () => {
    assert.equal(isCollapsibleBashCommand('echo foo > bar.txt'), false)
    assert.equal(isCollapsibleBashCommand('cat a >> b'), false)
  })

  it('returns false for file mutation commands', () => {
    assert.equal(isCollapsibleBashCommand('rm -rf node_modules'), false)
    assert.equal(isCollapsibleBashCommand('cp a b'), false)
    assert.equal(isCollapsibleBashCommand('mv a b'), false)
    assert.equal(isCollapsibleBashCommand('mkdir dist'), false)
    assert.equal(isCollapsibleBashCommand('touch file'), false)
    assert.equal(isCollapsibleBashCommand('chmod +x script.sh'), false)
  })

  it('returns false for git mutation subcommands', () => {
    assert.equal(isCollapsibleBashCommand('git commit -m "x"'), false)
    assert.equal(isCollapsibleBashCommand('git push'), false)
    assert.equal(isCollapsibleBashCommand('git checkout main'), false)
    assert.equal(isCollapsibleBashCommand('git pull origin main'), false)
  })

  it('returns false for package manager install', () => {
    assert.equal(isCollapsibleBashCommand('npm install'), false)
    assert.equal(isCollapsibleBashCommand('yarn add lodash'), false)
    assert.equal(isCollapsibleBashCommand('pnpm install'), false)
    assert.equal(isCollapsibleBashCommand('bun install'), false)
  })

  it('returns false for sed in-place edit', () => {
    assert.equal(isCollapsibleBashCommand('sed -i "s/a/b/" file'), false)
    assert.equal(isCollapsibleBashCommand('sed --in-place "s/a/b/" file'), false)
  })

  it('returns false for find with -exec/-delete', () => {
    assert.equal(isCollapsibleBashCommand('find . -name "*.tmp" -delete'), false)
    assert.equal(isCollapsibleBashCommand('find . -exec rm {} \\;'), false)
  })

  it('returns false for make/build', () => {
    assert.equal(isCollapsibleBashCommand('make'), false)
    assert.equal(isCollapsibleBashCommand('make test'), false)
  })

  it('returns false for commands exceeding length limit', () => {
    const long = 'echo ' + 'x'.repeat(MAX_COLLAPSIBLE_COMMAND_LEN)
    assert.equal(isCollapsibleBashCommand(long), false)
  })

  it('is case-insensitive', () => {
    assert.equal(isCollapsibleBashCommand('GIT PUSH'), false)
    assert.equal(isCollapsibleBashCommand('SED -I S/A/B/ FILE'), false)
  })

  it('returns false for empty/whitespace command', () => {
    assert.equal(isCollapsibleBashCommand(''), false)
    assert.equal(isCollapsibleBashCommand('   '), false)
  })
})

// ── Stats / Summary ────────────────────────────────────────────

describe('computeBashGroupStats', () => {
  it('counts completed, pending, and failed entries', () => {
    const group = makeGroup([
      { id: '1', completed: true },
      { id: '2', completed: true, isError: true },
      { id: '3', completed: false },
    ])
    const stats = computeBashGroupStats(group)
    assert.equal(stats.total, 3)
    assert.equal(stats.completed, 2)
    assert.equal(stats.pending, 1)
    assert.equal(stats.failed, 1)
  })
})

describe('buildBashSummaryText', () => {
  it('renders singular/plural correctly', () => {
    assert.ok(buildBashSummaryText(makeGroup([{ completed: true }]), false).includes('Ran 1 shell command'))
    assert.ok(buildBashSummaryText(makeGroup([{ completed: true }, { completed: true }]), false).includes('Ran 2 shell commands'))
  })

  it('includes failed and pending counts when active', () => {
    const text = buildBashSummaryText(makeGroup([
      { completed: true },
      { completed: true, isError: true },
      { completed: false },
    ]), true)
    assert.ok(text.includes('1 failed'))
    assert.ok(text.includes('1 pending'))
  })

  it('returns "…" when no completed entries', () => {
    const text = buildBashSummaryText(makeGroup([
      { completed: false },
    ]), false)
    assert.equal(text, '…')
  })
})

describe('buildBashLiveSummaryText', () => {
  it('shows "Running N" when pending', () => {
    const text = buildBashLiveSummaryText(makeGroup([
      { completed: true },
      { completed: false },
      { completed: false },
    ]))
    assert.ok(text.includes('Running 2 shell commands'))
  })

  it('falls back to completed summary when no pending', () => {
    const text = buildBashLiveSummaryText(makeGroup([{ completed: true }]))
    assert.ok(text.includes('Ran 1 shell command'))
  })
})

// ── Rendering ──────────────────────────────────────────────────

describe('formatCollapsedBashGroup', () => {
  it('renders summary line with elapsed time', () => {
    const group = makeGroup([
      { id: '1', command: 'pwd', completed: true, content: '/home/user' },
      { id: '2', command: 'ls', completed: true, content: 'a\nb' },
    ])
    const lines = formatCollapsedBashGroup({ group, theme })
    assert.ok(lines[0]!.includes('▶'))
    assert.ok(lines[0]!.includes('Ran 2 shell commands'))
  })

  it('lists commands when <= 3 entries', () => {
    const group = makeGroup([
      { id: '1', command: 'pwd', completed: true },
      { id: '2', command: 'ls', completed: true },
      { id: '3', command: 'cat README', completed: true },
    ])
    const lines = formatCollapsedBashGroup({ group, theme })
    assert.ok(lines.some(l => l.includes('pwd')))
    assert.ok(lines.some(l => l.includes('ls')))
    assert.ok(lines.some(l => l.includes('cat README')))
  })

  it('shows compact preview and ctrl+o hint when > 3 entries', () => {
    const group = makeGroup([
      { id: '1', command: 'pwd', completed: true },
      { id: '2', command: 'ls', completed: true },
      { id: '3', command: 'cat README', completed: true },
      { id: '4', command: 'whoami', completed: true },
    ])
    const lines = formatCollapsedBashGroup({ group, theme })
    assert.ok(lines.some(l => l.includes('[Ctrl+O]')))
    assert.ok(lines.some(l => l.includes('… +1 more command')))
  })

  it('marks failed entries', () => {
    const group = makeGroup([
      { id: '1', command: 'false', completed: true, isError: true },
    ])
    const lines = formatCollapsedBashGroup({ group, theme })
    assert.ok(lines.some(l => l.includes('✗')))
  })
})

describe('formatCollapsedBashGroupLive', () => {
  it('renders running summary', () => {
    const group = makeGroup([
      { id: '1', command: 'pwd', completed: false },
    ])
    const lines = formatCollapsedBashGroupLive(group, theme)
    assert.ok(lines[0]!.includes('Running 1 shell command'))
  })

  it('shows tail of last completed output', () => {
    const group = makeGroup([
      { id: '1', command: 'cat a', completed: true, content: 'line1\nline2' },
      { id: '2', command: 'cat b', completed: false },
    ])
    const lines = formatCollapsedBashGroupLive(group, theme)
    assert.ok(lines.some(l => l.includes('line2')))
  })
})

// ── Buffer ─────────────────────────────────────────────────────

describe('CollapsedBashBuffer', () => {
  it('starts empty', () => {
    const buf = new CollapsedBashBuffer()
    assert.equal(buf.isActive(), false)
    assert.equal(buf.getActive(), null)
    assert.equal(buf.hasPending(), false)
  })

  it('pushUse creates group and preserves first startMs', () => {
    const buf = new CollapsedBashBuffer()
    const t1 = Date.now()
    buf.pushUse('id-1', 'pwd', t1)
    const t2 = Date.now()
    buf.pushUse('id-2', 'ls', t2)
    const group = buf.getActive()!
    assert.equal(group.entries.length, 2)
    assert.equal(group.startMs, t1)
    assert.equal(group.entries[1]!.startMs, t2)
  })

  it('attachResult binds by id', () => {
    const buf = new CollapsedBashBuffer()
    buf.pushUse('id-A', 'pwd', Date.now())
    buf.pushUse('id-B', 'ls', Date.now())
    buf.attachResult('id-B', '/dir')
    const group = buf.getActive()!
    assert.equal(group.entries[0]!.content, undefined)
    assert.equal(group.entries[1]!.content, '/dir')
  })

  it('detachEntry removes entry and clears empty group', () => {
    const buf = new CollapsedBashBuffer()
    buf.pushUse('id-1', 'pwd', Date.now())
    const entry = buf.detachEntry('id-1')
    assert.ok(entry)
    assert.equal(buf.isActive(), false)
    assert.equal(buf.detachEntry('id-1'), null)
  })

  it('flush returns group and clears buffer', () => {
    const buf = new CollapsedBashBuffer()
    buf.pushUse('id-1', 'pwd', Date.now())
    const flushed = buf.flush()
    assert.ok(flushed)
    assert.equal(buf.isActive(), false)
    assert.equal(buf.flush(), null)
  })
})
