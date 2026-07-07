import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { appendLog, appendLogInPlace, summarizeToolOutput, updateToolLog, visibleLogs, createLogEntry, MAX_LOG_STORE, type LogEntry } from '../log-state.js'

describe('TUI log state helpers', () => {
  it('updates an existing tool log instead of appending a duplicate', () => {
    const logs: LogEntry[] = [
      { type: 'user_message', id: 'l0', content: '> npm test' },
      { type: 'tool', id: 'tool-1', toolName: 'bash', content: 'running' },
    ]

    const updated = updateToolLog(logs, 'tool-1', 'bash', 'done', false)

    assert.equal(updated.length, 2)
    assert.deepEqual(updated[1], {
      type: 'tool',
      id: 'tool-1',
      toolName: 'bash',
      content: 'done',
      isError: false,
      rawPath: undefined,
    })
  })

  it('appends when no matching tool log exists', () => {
    const updated = updateToolLog([], 'tool-1', 'bash', 'done', false)

    assert.deepEqual(updated, [{
      type: 'tool',
      id: 'tool-1',
      toolName: 'bash',
      content: 'done',
      isError: false,
      rawPath: undefined,
    }])
  })

  it('keeps only the visible tail of logs', () => {
    const logs = Array.from({ length: 60 }, (_, i): LogEntry => ({ type: 'user_message', id: `l${i}`, content: String(i) }))

    assert.equal(visibleLogs(logs, 50).length, 50)
    assert.equal(visibleLogs(logs, 50)[0]!.content, '10')
  })

  it('summarizes long tool output with head and tail', () => {
    const output = Array.from({ length: 80 }, (_, i) => `line-${i}`).join('\n')
    const summary = summarizeToolOutput(output, 20)

    assert.ok(summary.includes('line-0'))
    assert.ok(summary.includes('line-79'))
    assert.ok(summary.includes('60 lines omitted'))
  })

  it('summarizes appended tool chunks before rendering', () => {
    const first = 'a\n'.repeat(40)
    const second = 'b\n'.repeat(40)
    const summary = summarizeToolOutput(first + second, 24)

    assert.ok(summary.split('\n').length <= 25)
    assert.ok(summary.includes('lines omitted'))
  })

  it('assigns stable sequential IDs to log entries', () => {
    const a = createLogEntry({ type: 'user_message', content: 'hello' })
    const b = createLogEntry({ type: 'user_message', content: 'world' })

    assert.ok(a.id.startsWith('l'))
    assert.ok(b.id.startsWith('l'))
    assert.notEqual(a.id, b.id)
  })

  it('preserves preset ID when given', () => {
    const entry = createLogEntry({ id: 'tool-42', type: 'tool', content: 'result' })

    assert.equal(entry.id, 'tool-42')
  })

  it('appends immutably and trims when exceeding store limit', () => {
    let logs: LogEntry[] = []
    const original = logs
    logs = appendLog(logs, { type: 'user_message', id: 'first', content: 'first' })

    assert.notEqual(logs, original)
    assert.equal(original.length, 0)
    assert.equal(logs.length, 1)

    for (let i = 0; i < MAX_LOG_STORE + 100; i++) {
      logs = appendLog(logs, { type: 'user_message', id: `l${i}`, content: String(i) })
    }

    assert.ok(logs.length <= MAX_LOG_STORE)
    assert.ok(logs.length > 0)
  })

  it('keeps appendLogInPlace as a compatibility wrapper', () => {
    const logs: LogEntry[] = []
    appendLogInPlace(logs, { type: 'user_message', id: 'l1', content: '1' })

    assert.deepEqual(logs, [{ type: 'user_message', id: 'l1', content: '1' }])
  })
})

describe('LogEntry extended types', () => {
  it('creates user_message entry', () => {
    const entry = createLogEntry({ type: 'user_message', content: 'hello', turnNumber: 1 })
    assert.equal(entry.type, 'user_message')
    assert.equal(entry.content, 'hello')
    assert.equal(entry.turnNumber, 1)
    assert.ok(entry.id.startsWith('l'))
  })

  it('creates assistant_message entry', () => {
    const entry = createLogEntry({ type: 'assistant_message', content: 'response', turnNumber: 1 })
    assert.equal(entry.type, 'assistant_message')
    assert.equal(entry.turnNumber, 1)
  })

  it('creates system entry with isError flag', () => {
    const entry = createLogEntry({ type: 'system', content: 'Error: timeout', isError: true })
    assert.equal(entry.type, 'system')
    assert.equal(entry.isError, true)
  })

  it('creates tool_group entry with children', () => {
    const children = [
      createLogEntry({ type: 'tool', content: 'ok', toolName: 'read_file' }),
      createLogEntry({ type: 'tool', content: 'ok', toolName: 'grep' }),
    ]
    const group = createLogEntry({ type: 'tool_group', content: '', children, turnNumber: 2 })
    assert.equal(group.type, 'tool_group')
    assert.equal(group.children!.length, 2)
    assert.equal(group.turnNumber, 2)
  })

  it('createLogEntry accepts turnNumber and children', () => {
    const entry = createLogEntry({
      type: 'tool',
      content: 'test',
      turnNumber: 5,
      children: [],
    })
    assert.equal(entry.turnNumber, 5)
    assert.deepEqual(entry.children, [])
  })
})
