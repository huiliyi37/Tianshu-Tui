/**
 * collapsed-read-search 纯函数测试。
 *
 * RED 条件表（10 条）：每条测试对应一种偷懒实现——实现者按 checklist 打勾
 * 也会红的测试，确保只在正确实现下全绿。
 */

import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  isCollapsibleTool,
  classifyCollapsibleKind,
  shouldBreakGroup,
  entryDisplayName,
  findEntryById,
  attachResult,
  computeGroupStats,
  buildSummaryText,
  formatCollapsedGroup,
  formatCollapsedGroupLive,
  CollapsedReadSearchBuffer,
  type CollapsedReadSearchGroup,
} from '../format/collapsed-read-search.js'
import { getTheme } from '../theme.js'

const theme = getTheme()

// ── Helpers ────────────────────────────────────────────────────

function makeGroup(entries: Array<Partial<import('../format/collapsed-read-search.js').CollapsedReadSearchEntry>> = []): CollapsedReadSearchGroup {
  return {
    entries: entries.map((e, i) => ({
      id: e.id ?? `id-${i}`,
      toolName: e.toolName ?? 'read_file',
      input: e.input ?? {},
      displayName: e.displayName ?? 'file.ts',
      kind: e.kind ?? 'read',
      content: e.content,
      isError: e.isError,
      completed: e.completed ?? false,
    })),
    startMs: Date.now() - 1000,
  }
}

function makeEntry(overrides: Partial<import('../format/collapsed-read-search.js').CollapsedReadSearchEntry> = {}) {
  return {
    id: overrides.id ?? 'id-0',
    toolName: overrides.toolName ?? 'read_file',
    input: overrides.input ?? {},
    displayName: overrides.displayName ?? 'src/foo.ts',
    kind: overrides.kind ?? 'read',
    content: overrides.content,
    isError: overrides.isError,
    completed: overrides.completed ?? false,
  }
}

// ── Classification ─────────────────────────────────────────────

describe('isCollapsibleTool', () => {
  // 1. 忘记注册 read_file
  it('returns true for read_file', () => {
    assert.equal(isCollapsibleTool('read_file'), true)
  })
  it('returns true for read_file alias "read"', () => {
    assert.equal(isCollapsibleTool('read'), true)
  })

  it('returns true for grep', () => {
    assert.equal(isCollapsibleTool('grep'), true)
  })
  it('returns true for glob', () => {
    assert.equal(isCollapsibleTool('glob'), true)
  })
  it('returns true for semantic_search', () => {
    assert.equal(isCollapsibleTool('semantic_search'), true)
  })

  // 1b. G2 扩展：read_policy / read_section / file_info
  it('returns true for G2-extended read tools', () => {
    assert.equal(isCollapsibleTool('read_policy'), true)
    assert.equal(isCollapsibleTool('read_section'), true)
    assert.equal(isCollapsibleTool('file_info'), true)
  })

  // 1c. G2 扩展：repo_map / repo_graph / related_tests / inspect_project / ls
  it('returns true for G2-extended search tools', () => {
    assert.equal(isCollapsibleTool('repo_map'), true)
    assert.equal(isCollapsibleTool('repo_graph'), true)
    assert.equal(isCollapsibleTool('related_tests'), true)
    assert.equal(isCollapsibleTool('inspect_project'), true)
    assert.equal(isCollapsibleTool('ls'), true)
  })

  // 2. 误将 write 纳入折叠
  it('returns false for write_file', () => {
    assert.equal(isCollapsibleTool('write_file'), false)
  })
  it('returns false for edit_file', () => {
    assert.equal(isCollapsibleTool('edit_file'), false)
  })
  it('returns false for bash', () => {
    assert.equal(isCollapsibleTool('bash'), false)
  })
  it('returns false for delegate_task', () => {
    assert.equal(isCollapsibleTool('delegate_task'), false)
  })
  it('returns false for team_orchestrate', () => {
    assert.equal(isCollapsibleTool('team_orchestrate'), false)
  })

  it('is case-insensitive', () => {
    assert.equal(isCollapsibleTool('READ_FILE'), true)
    assert.equal(isCollapsibleTool('Grep'), true)
  })
})

describe('shouldBreakGroup', () => {
  // 3. write 没打断组
  it('returns true for non-collapsible tools (write_file)', () => {
    assert.equal(shouldBreakGroup('write_file'), true)
  })
  // 4. 同族误打断
  it('returns false for collapsible tools (read_file)', () => {
    assert.equal(shouldBreakGroup('read_file'), false)
  })
  it('returns false for collapsible tools (grep)', () => {
    assert.equal(shouldBreakGroup('grep'), false)
  })
})

// ── Entry display ──────────────────────────────────────────────

describe('entryDisplayName', () => {
  it('extracts file_path for read_file', () => {
    assert.equal(entryDisplayName('read_file', { file_path: 'src/foo.ts' }), 'src/foo.ts')
  })
  it('extracts pattern and path for grep', () => {
    const name = entryDisplayName('grep', { pattern: 'TODO', path: 'src/' })
    assert.ok(name.includes('"TODO"'))
    assert.ok(name.includes('src/'))
  })
  it('falls back to toolName for unknown tools', () => {
    assert.equal(entryDisplayName('unknown_tool', {}), 'unknown_tool')
  })
})

// ── Entry lookup (CORRECTNESS-CRITICAL) ────────────────────────

describe('findEntryById', () => {
  it('finds entry by id in group', () => {
    const group = makeGroup([
      { id: 'abc', displayName: 'a.ts' },
      { id: 'def', displayName: 'b.ts' },
    ])
    const entry = findEntryById(group, 'def')
    assert.ok(entry)
    assert.equal(entry.displayName, 'b.ts')
  })

  it('returns null for unknown id', () => {
    const group = makeGroup([{ id: 'abc' }])
    assert.equal(findEntryById(group, 'nonexistent'), null)
  })
})

describe('attachResult', () => {
  // 5. 命中正确 entry（核心正确性：id 绑定而非 name/position 匹配）
  it('attaches result to correct entry by id', () => {
    const group = makeGroup([
      { id: 'id-A', displayName: 'a.ts', completed: false },
      { id: 'id-B', displayName: 'b.ts', completed: false },
    ])
    attachResult(group, 'id-A', 'content for A')
    // A 被更新
    assert.equal(group.entries[0]!.content, 'content for A')
    assert.equal(group.entries[0]!.completed, true)
    // B 未被影响
    assert.equal(group.entries[1]!.content, undefined)
    assert.equal(group.entries[1]!.completed, false)
  })

  // 6. unknown id → null（不静默写入）
  it('returns null for unknown id (no silent write)', () => {
    const group = makeGroup([{ id: 'id-A' }])
    const result = attachResult(group, 'id-NONEXISTENT', 'oops')
    assert.equal(result, null)
    // 原始 entry 未被篡改
    assert.equal(group.entries[0]!.content, undefined)
    assert.equal(group.entries[0]!.completed, false)
  })
})

// ── Stats ──────────────────────────────────────────────────────

describe('computeGroupStats', () => {
  it('counts completed search entries', () => {
    const group = makeGroup([
      { id: '1', kind: 'search', completed: true },
      { id: '2', kind: 'search', completed: true },
      { id: '3', kind: 'search', completed: false },
    ])
    const stats = computeGroupStats(group)
    assert.equal(stats.searchCount, 2)
    assert.equal(stats.pendingCount, 1)
  })

  // 7. 仅统计 completed entry（G4 回归）
  it('excludes uncompleted entries from counts', () => {
    const group = makeGroup([
      { id: '1', kind: 'read', displayName: 'a.ts', completed: false },
      { id: '2', kind: 'read', displayName: 'b.ts', completed: false },
    ])
    const stats = computeGroupStats(group)
    assert.equal(stats.readFilePaths.length, 0)
    assert.equal(stats.completedCount, 0)
    assert.equal(stats.pendingCount, 2)
  })

  it('deduplicates read file paths', () => {
    const group = makeGroup([
      { id: '1', kind: 'read', displayName: 'a.ts', completed: true },
      { id: '2', kind: 'read', displayName: 'a.ts', completed: true },
      { id: '3', kind: 'read', displayName: 'b.ts', completed: true },
    ])
    const stats = computeGroupStats(group)
    assert.equal(stats.readFilePaths.length, 2)
  })

  it('handles mixed read+search', () => {
    const group = makeGroup([
      { id: '1', kind: 'read', displayName: 'a.ts', completed: true },
      { id: '2', kind: 'search', completed: true },
      { id: '3', kind: 'read', displayName: 'b.ts', completed: true },
    ])
    const stats = computeGroupStats(group)
    assert.equal(stats.searchCount, 1)
    assert.equal(stats.readFilePaths.length, 2)
  })
})

describe('buildSummaryText', () => {
  // 8. 混合组显示两种统计
  it('shows both read and search for mixed groups', () => {
    const group = makeGroup([
      { id: '1', kind: 'read', displayName: 'a.ts', completed: true },
      { id: '2', kind: 'search', completed: true },
    ])
    const text = buildSummaryText(group, false)
    assert.ok(text.includes('Read'))
    assert.ok(text.includes('Searched'))
  })

  it('shows only read when no search', () => {
    const group = makeGroup([
      { id: '1', kind: 'read', displayName: 'a.ts', completed: true },
    ])
    const text = buildSummaryText(group, false)
    assert.ok(text.includes('Read'))
    assert.ok(!text.includes('Searched'))
  })

  // 9. 0 个 completed → 显示 "…"
  it('returns "…" when no completed entries', () => {
    const group = makeGroup([
      { id: '1', kind: 'read', displayName: 'a.ts', completed: false },
    ])
    const text = buildSummaryText(group, false)
    assert.equal(text, '…')
  })

  it('shows pending count when isActive', () => {
    const group = makeGroup([
      { id: '1', kind: 'read', displayName: 'a.ts', completed: true },
      { id: '2', kind: 'search', completed: false },
    ])
    const text = buildSummaryText(group, true)
    assert.ok(text.includes('pending'))
  })
})

// ── Rendering ──────────────────────────────────────────────────

describe('formatCollapsedGroup', () => {
  it('renders summary line with elapsed time', () => {
    const group = makeGroup([
      { id: '1', kind: 'read', displayName: 'a.ts', completed: true, content: 'line1\nline2' },
      { id: '2', kind: 'search', completed: true },
    ])
    const lines = formatCollapsedGroup({ group, theme })
    assert.ok(lines.length >= 1)
    assert.ok(lines[0]!.includes('▶')) // 折叠组头用 ▶/▼ 展开指示器（原 ●）
  })

  it('expanded mode shows more entries', () => {
    const entries = Array.from({ length: 5 }, (_, i) => ({
      id: `id-${i}`,
      kind: 'read' as const,
      displayName: `file${i}.ts`,
      completed: true,
      content: `line${i}-1\nline${i}-2`,
    }))
    const group = makeGroup(entries)
    const collapsed = formatCollapsedGroup({ group, theme, expanded: false })
    const expanded = formatCollapsedGroup({ group, theme, expanded: true })
    assert.ok(expanded.length > collapsed.length, 'expanded should have more lines')
  })

  it('shows "(results pending…)" when no completed entries', () => {
    const group = makeGroup([
      { id: '1', kind: 'read', displayName: 'a.ts', completed: false },
    ])
    const lines = formatCollapsedGroup({ group, theme })
    assert.ok(lines.some(l => l.includes('pending')))
  })
})

describe('formatCollapsedGroupLive', () => {
  it('renders active summary line', () => {
    const group = makeGroup([
      { id: '1', kind: 'read', displayName: 'a.ts', completed: false },
    ])
    const lines = formatCollapsedGroupLive(group, theme)
    assert.ok(lines.length >= 1)
    assert.ok(lines[0]!.includes('●'))
  })

  it('shows preview of last completed entry content', () => {
    const group = makeGroup([
      { id: '1', kind: 'read', displayName: 'a.ts', completed: true, content: 'preview line 1\npreview line 2' },
      { id: '2', kind: 'read', displayName: 'b.ts', completed: false },
    ])
    const lines = formatCollapsedGroupLive(group, theme)
    // 应该有 header + 预览行
    const contentLines = lines.slice(1).filter(l => l.includes('preview'))
    assert.ok(contentLines.length > 0)
  })
})

// ── Buffer ─────────────────────────────────────────────────────

describe('CollapsedReadSearchBuffer', () => {
  it('starts empty', () => {
    const buf = new CollapsedReadSearchBuffer()
    assert.equal(buf.isActive(), false)
    assert.equal(buf.getActive(), null)
    assert.equal(buf.hasPending(), false)
  })

  it('pushUse creates group and adds entry', () => {
    const buf = new CollapsedReadSearchBuffer()
    buf.pushUse('id-1', 'read_file', { file_path: 'src/foo.ts' })
    assert.equal(buf.isActive(), true)
    const group = buf.getActive()!
    assert.equal(group.entries.length, 1)
    assert.equal(group.entries[0]!.id, 'id-1')
    assert.equal(group.entries[0]!.completed, false)
  })

  // 10. 并行绑定正确性
  it('attachResult binds to correct entry by id (parallel correctness)', () => {
    const buf = new CollapsedReadSearchBuffer()
    buf.pushUse('id-A', 'read_file', { file_path: 'a.ts' })
    buf.pushUse('id-B', 'read_file', { file_path: 'b.ts' })
    buf.pushUse('id-C', 'read_file', { file_path: 'c.ts' })

    // 结果乱序到达
    buf.attachResult('id-B', 'content B')
    buf.attachResult('id-A', 'content A')
    buf.attachResult('id-C', 'content C')

    const group = buf.getActive()!
    assert.equal(group.entries[0]!.content, 'content A')
    assert.equal(group.entries[1]!.content, 'content B')
    assert.equal(group.entries[2]!.content, 'content C')
    assert.ok(group.entries.every(e => e.completed))
  })

  it('flush returns group and clears buffer', () => {
    const buf = new CollapsedReadSearchBuffer()
    buf.pushUse('id-1', 'read_file', { file_path: 'a.ts' })
    const flushed = buf.flush()
    assert.ok(flushed)
    assert.equal(flushed.entries.length, 1)
    assert.equal(buf.isActive(), false)
    // 重复 flush 返回 null
    assert.equal(buf.flush(), null)
  })

  it('shouldBreak returns true for non-collapsible tool', () => {
    const buf = new CollapsedReadSearchBuffer()
    assert.equal(buf.shouldBreak('write_file'), true)
  })

  it('pushUse with non-collapsible tool is a no-op (defensive)', () => {
    const buf = new CollapsedReadSearchBuffer()
    buf.pushUse('id-1', 'write_file', { file_path: 'out.txt' })
    assert.equal(buf.isActive(), false)
  })

  it('hasPending detects uncompleted entries', () => {
    const buf = new CollapsedReadSearchBuffer()
    buf.pushUse('id-1', 'read_file', { file_path: 'a.ts' })
    assert.equal(buf.hasPending(), true)
    buf.attachResult('id-1', 'done')
    assert.equal(buf.hasPending(), false)
  })
})
