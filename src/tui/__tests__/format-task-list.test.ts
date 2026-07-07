import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { formatTaskList } from '../format/task-list.js'
import { getTheme } from '../theme.js'
import { displayWidth } from '../width.js'
import type { TodoItem } from '../../tools/todo-store.js'

const theme = getTheme()
const stripAnsi = (s: string) => s.replace(/\x1B\[[0-9;]*[a-zA-Z]/g, '')

const mk = (id: string, content: string, status: TodoItem['status']): TodoItem => ({ id, content, status })

describe('formatTaskList', () => {
  it('returns [] for empty list (panel not rendered)', () => {
    assert.deepEqual(formatTaskList([], theme), [])
  })

  it('renders three-state glyphs', () => {
    const lines = formatTaskList([
      mk('1', 'done thing', 'completed'),
      mk('2', 'current thing', 'in_progress'),
      mk('3', 'future thing', 'pending'),
    ], theme).map(stripAnsi)
    const body = lines.join('\n')
    assert.ok(body.includes('◐ current thing'), `in_progress: ${body}`)
    assert.ok(body.includes('☐ future thing'), `pending: ${body}`)
    assert.ok(!body.includes('☒ done thing'), 'completed should NOT be item-by-item')
  })

  it('renders a header with done/total count', () => {
    const lines = formatTaskList([
      mk('1', 'a', 'completed'),
      mk('2', 'b', 'pending'),
    ], theme).map(stripAnsi)
    assert.ok(lines[0]!.includes('1/2'), `header: ${lines[0]}`)
  })

  it('highlights in_progress with ANSI styling', () => {
    const lines = formatTaskList([
      mk('1', 'a', 'pending'),
      mk('2', 'b', 'in_progress'),
    ], theme)
    const inProgressLine = lines[2]!
    assert.ok(/\x1B\[1m/.test(inProgressLine), 'in_progress line is bold')
  })

  it('shows in_progress even when many completed items fill the list', () => {
    // 8 items: 6 completed + 1 in_progress + 1 pending, maxRows=6
    // Old behavior: showed first 5 items (all completed) + "+3 more"
    // → in_progress (item 7) was buried. New behavior: in_progress must be visible.
    const items: TodoItem[] = [
      mk('1', 'task 1', 'completed'),
      mk('2', 'task 2', 'completed'),
      mk('3', 'task 3', 'completed'),
      mk('4', 'task 4', 'completed'),
      mk('5', 'task 5', 'completed'),
      mk('6', 'task 6', 'completed'),
      mk('7', 'ACTIVE task', 'in_progress'),
      mk('8', 'pending task', 'pending'),
    ]
    const lines = formatTaskList(items, theme, { maxRows: 6 }).map(stripAnsi)
    const body = lines.join('\n')
    assert.ok(body.includes('◐ ACTIVE task'), `in_progress must be visible: ${body}`)
    assert.ok(body.includes('6 done'), `completed summary: ${body}`)
    assert.ok(body.includes('☐ pending task'), `pending must be visible: ${body}`)
  })

  it('collapses completed items to a single summary line', () => {
    const items: TodoItem[] = [
      mk('1', 'task 1', 'completed'),
      mk('2', 'task 2', 'completed'),
      mk('3', 'task 3', 'completed'),
      mk('4', 'active task', 'in_progress'),
    ]
    const lines = formatTaskList(items, theme, { maxRows: 6 }).map(stripAnsi)
    const body = lines.join('\n')
    // Should have "3 done" not individual completed items
    assert.ok(body.includes('3 done'), `summary line: ${body}`)
    assert.ok(!body.includes('☒ task 1'), `completed item should not be shown individually: ${body}`)
  })

  it('shows single completed item content in summary', () => {
    const items: TodoItem[] = [
      mk('1', 'the completed one', 'completed'),
      mk('2', 'active', 'in_progress'),
    ]
    const lines = formatTaskList(items, theme).map(stripAnsi)
    const body = lines.join('\n')
    assert.ok(body.includes('✓ the completed one'), `single done: ${body}`)
  })

  it('truncates long content to width', () => {
    const long = 'x'.repeat(200)
    const lines = formatTaskList([mk('1', long, 'pending')], theme, { width: 40 })
    const plain = stripAnsi(lines[1]!)
    assert.ok(plain.includes('…'), 'has ellipsis')
    assert.ok(plain.length <= 42, `truncated to width: ${plain.length}`)
  })

  it('truncates CJK content by display width, not code-unit length', () => {
    // 旧实现用 .length 截断：30 个 CJK 字符 length=30 但实际占 60 列，width=40 时不触发
    // 截断 → 单行任务溢出终端宽度折行 → rowsForLine 低估 → chrome 残留重影。
    // 新实现按显示宽度截断：每 CJK 字符 2 列，30 字 = 60 列 > 36（width-4）→ 截断。
    const long = '重构'.repeat(15) // 30 个 CJK 字符
    const lines = formatTaskList([mk('1', long, 'pending')], theme, { width: 40 })
    const plain = stripAnsi(lines[1]!)
    assert.ok(plain.includes('…'), 'CJK 超宽应截断带省略号')
    // 去掉 glyph(1) + 空格(1) 后，内容显示宽度应 ≤ width-4（maxContentWidth）
    assert.ok(displayWidth(plain, { ambiguousAsWide: true }) <= 40,
      `CJK 任务行显示宽度应 ≤ 40: ${displayWidth(plain, { ambiguousAsWide: true })}`)
  })

  it('truncates content containing ambiguous symbols by wide width', () => {
    // 任务含 — … → ·（CJK 终端按 2 列渲染）：旧 narrow 实现低估，新 wide 实现正确截断。
    const content = '边界处理——注意并发…以及重试→策略' + '·'.repeat(20)
    const lines = formatTaskList([mk('1', content, 'in_progress')], theme, { width: 40 })
    const plain = stripAnsi(lines[1]!)
    assert.ok(plain.includes('…'), '含 ambiguous 符号超宽应截断')
    assert.ok(displayWidth(plain, { ambiguousAsWide: true }) <= 40,
      `含 ambiguous 任务行显示宽度应 ≤ 40: ${displayWidth(plain, { ambiguousAsWide: true })}`)
  })

  it('overflows pending when too many unfinished items', () => {
    // 8 pending + 0 completed, maxRows=6 → budget=5, visible=4, +4 more
    const items = Array.from({ length: 8 }, (_, i) => mk(String(i), `task ${i}`, 'pending'))
    const lines = formatTaskList(items, theme, { maxRows: 6 }).map(stripAnsi)
    assert.ok(lines.some(l => /\+\d+ more/.test(l)), `has +N more: ${lines.join(' | ')}`)
    assert.ok(lines.length <= 6, `lines ${lines.length} <= 6`)
  })

  // ── 反证：旧实现（按原序取前 N）会在此测试中红 ──

  it('RED for old impl: in_progress buried after 6 completed in a 8-item list', () => {
    // Old code took items[0..visibleCount-1] which were all completed,
    // then showed "+3 more". in_progress (index 6) was invisible.
    const items: TodoItem[] = [
      ...Array.from({ length: 6 }, (_, i) => mk(`c${i}`, `completed ${i}`, 'completed')),
      mk('7', 'IMPORTANT active', 'in_progress'),
      mk('8', 'next pending', 'pending'),
    ]
    const lines = formatTaskList(items, theme, { maxRows: 6 }).map(stripAnsi)
    const body = lines.join('\n')
    // New impl: in_progress visible, completed collapsed to "6 done"
    assert.ok(body.includes('IMPORTANT active'), `new impl must show active: ${body}`)
    // Old impl would show "completed 0..4" + "+3 more" — in_progress invisible
    assert.ok(!body.includes('+3 more'), `no overflow when budget suffices: ${body}`)
  })

  // ── P0: Progress bar + in_progress prefix ──

  it('header includes 8-cell progress bar', () => {
    const items = [
      mk('1', 'task A', 'completed'),
      mk('2', 'task B', 'completed'),
      mk('3', 'task C', 'pending'),
      mk('4', 'task D', 'pending'),
    ]
    const lines = formatTaskList(items, theme, { width: 80, showProgressBar: true })
    const header = stripAnsi(lines[0]!)
    // 2/4 = 50% → 4 filled cells out of 8
    assert.ok(header.includes('█'), 'progress bar has filled cells')
    assert.ok(header.includes('░'), 'progress bar has empty cells')
    assert.ok(header.includes('2/4'), 'count preserved')
  })

  it('progress bar all empty when nothing done', () => {
    const items = [mk('1', 'task A', 'pending'), mk('2', 'task B', 'in_progress')]
    const lines = formatTaskList(items, theme, { width: 80, showProgressBar: true })
    const header = stripAnsi(lines[0]!)
    assert.ok(header.includes('░'), 'all empty cells')
    assert.ok(!header.includes('█'), 'no filled cells when 0 done')
  })

  it('progress bar all filled when all done', () => {
    const items = [mk('1', 'task A', 'completed'), mk('2', 'task B', 'completed')]
    const lines = formatTaskList(items, theme, { width: 80, showProgressBar: true })
    const header = stripAnsi(lines[0]!)
    assert.ok(header.includes('█'), 'all filled cells')
    assert.ok(!header.includes('░'), 'no empty cells when all done')
  })

  it('in_progress line has ▸ prefix for visual focus', () => {
    const items = [
      mk('1', 'done task', 'completed'),
      mk('2', 'active task', 'in_progress'),
      mk('3', 'pending task', 'pending'),
    ]
    const lines = formatTaskList(items, theme, { width: 80 })
    const activeLine = lines.find(l => stripAnsi(l).includes('active task'))
    const pendingLine = lines.find(l => stripAnsi(l).includes('pending task'))
    assert.ok(activeLine && stripAnsi(activeLine).includes('▸'), 'in_progress has ▸ prefix')
    assert.ok(pendingLine && !stripAnsi(pendingLine).includes('▸'), 'pending does NOT have ▸ prefix')
  })

  it('can hide progress bar for Claude Code-style compact header', () => {
    const items = [
      mk('1', 'task A', 'completed'),
      mk('2', 'task B', 'pending'),
    ]
    const lines = formatTaskList(items, theme, { width: 80, showProgressBar: false }).map(stripAnsi)
    const header = lines[0]!
    assert.ok(header.includes('◇ 任务 (1/2)'), `compact header: ${header}`)
    assert.ok(!header.includes('█'), 'no filled progress cells')
    assert.ok(!header.includes('░'), 'no empty progress cells')
  })
})
