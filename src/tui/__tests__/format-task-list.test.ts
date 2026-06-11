import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { formatTaskList } from '../format/task-list.js'
import { getTheme } from '../theme.js'
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
    assert.ok(body.includes('☒ done thing'), `completed: ${body}`)
    assert.ok(body.includes('◐ current thing'), `in_progress: ${body}`)
    assert.ok(body.includes('☐ future thing'), `pending: ${body}`)
  })

  it('renders a header with done/total count', () => {
    const lines = formatTaskList([
      mk('1', 'a', 'completed'),
      mk('2', 'b', 'pending'),
    ], theme).map(stripAnsi)
    assert.ok(lines[0]!.includes('1/2'), `header: ${lines[0]}`)
  })

  it('highlights in_progress with ANSI styling', () => {
    // lines[0] is the header; the in_progress item is the second body row.
    const lines = formatTaskList([
      mk('1', 'a', 'pending'),
      mk('2', 'b', 'in_progress'),
    ], theme)
    const inProgressLine = lines[2]!
    assert.ok(/\x1B\[1m/.test(inProgressLine), 'in_progress line is bold')
  })

  it('truncates to maxRows with a +N more line', () => {
    const items = Array.from({ length: 10 }, (_, i) => mk(String(i), `task ${i}`, 'pending'))
    const lines = formatTaskList(items, theme, { maxRows: 6 }).map(stripAnsi)
    // header + visible + "+N more" <= maxRows
    assert.ok(lines.length <= 6, `lines ${lines.length} <= 6`)
    assert.ok(lines.some(l => /\+\d+ more/.test(l)), `has +N more: ${lines.join(' | ')}`)
  })

  it('truncates long content to width', () => {
    const long = 'x'.repeat(200)
    const [, item] = formatTaskList([mk('1', long, 'pending')], theme, { width: 40 })
    const plain = stripAnsi(item!)
    assert.ok(plain.includes('…'), 'has ellipsis')
    assert.ok(plain.length <= 42, `truncated to width: ${plain.length}`)
  })
})
