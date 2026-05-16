import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { groupLogs } from '../group-logs.js'
import { createLogEntry, type LogEntry } from '../log-state.js'

describe('groupLogs', () => {
  it('returns items unchanged when fewer than 3 consecutive tools', () => {
    const items = [
      createLogEntry({ type: 'user_message', content: 'hi', turnNumber: 1 }),
      createLogEntry({ type: 'tool', content: 'ok', toolName: 'read_file', turnNumber: 1 }),
      createLogEntry({ type: 'tool', content: 'ok', toolName: 'grep', turnNumber: 1 }),
      createLogEntry({ type: 'assistant_message', content: 'done', turnNumber: 1 }),
    ]
    const result = groupLogs(items)
    assert.equal(result.length, 4)
  })

  it('groups 3+ consecutive tool entries into tool_group', () => {
    const items = [
      createLogEntry({ type: 'user_message', content: 'hi', turnNumber: 1 }),
      createLogEntry({ type: 'tool', content: 'a', toolName: 'read_file', turnNumber: 1 }),
      createLogEntry({ type: 'tool', content: 'b', toolName: 'read_file', turnNumber: 1 }),
      createLogEntry({ type: 'tool', content: 'c', toolName: 'grep', turnNumber: 1 }),
      createLogEntry({ type: 'assistant_message', content: 'done', turnNumber: 1 }),
    ]
    const result = groupLogs(items)
    assert.equal(result.length, 3)
    assert.equal(result[1]!.type, 'tool_group')
    assert.equal(result[1]!.children!.length, 3)
  })

  it('does not group tools from different turns', () => {
    const items = [
      createLogEntry({ type: 'tool', content: 'a', toolName: 'read_file', turnNumber: 1 }),
      createLogEntry({ type: 'tool', content: 'b', toolName: 'read_file', turnNumber: 1 }),
      createLogEntry({ type: 'assistant_message', content: 'done', turnNumber: 1 }),
      createLogEntry({ type: 'tool', content: 'c', toolName: 'grep', turnNumber: 2 }),
      createLogEntry({ type: 'tool', content: 'd', toolName: 'grep', turnNumber: 2 }),
      createLogEntry({ type: 'tool', content: 'e', toolName: 'read_file', turnNumber: 2 }),
    ]
    const result = groupLogs(items)
    assert.equal(result.length, 4)
    assert.equal(result[3]!.type, 'tool_group')
  })

  it('handles empty input', () => {
    assert.deepEqual(groupLogs([]), [])
  })

  it('handles all non-tool items', () => {
    const items = [
      createLogEntry({ type: 'user_message', content: 'a' }),
      createLogEntry({ type: 'assistant_message', content: 'b' }),
      createLogEntry({ type: 'system', content: 'c' }),
    ]
    assert.deepEqual(groupLogs(items), items)
  })

  it('groups tools at end of list', () => {
    const items = [
      createLogEntry({ type: 'user_message', content: 'hi', turnNumber: 1 }),
      createLogEntry({ type: 'tool', content: 'a', toolName: 'read_file', turnNumber: 1 }),
      createLogEntry({ type: 'tool', content: 'b', toolName: 'read_file', turnNumber: 1 }),
      createLogEntry({ type: 'tool', content: 'c', toolName: 'read_file', turnNumber: 1 }),
    ]
    const result = groupLogs(items)
    assert.equal(result.length, 2)
    assert.equal(result[1]!.type, 'tool_group')
  })

  it('groups tools without turnNumber', () => {
    const items = [
      createLogEntry({ type: 'tool', content: 'a', toolName: 'read_file' }),
      createLogEntry({ type: 'tool', content: 'b', toolName: 'read_file' }),
      createLogEntry({ type: 'tool', content: 'c', toolName: 'read_file' }),
    ]
    const result = groupLogs(items)
    assert.equal(result.length, 1)
    assert.equal(result[0]!.type, 'tool_group')
  })
})
