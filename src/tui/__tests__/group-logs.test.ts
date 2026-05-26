import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { groupLogs } from '../group-logs.js'
import { createLogEntry, type LogEntry } from '../log-state.js'

describe('groupLogs', () => {
  it('returns items unchanged when fewer than 5 consecutive tools', () => {
    const items = [
      createLogEntry({ type: 'user_message', content: 'hi', turnNumber: 1 }),
      createLogEntry({ type: 'tool', content: 'a', toolName: 'read_file', turnNumber: 1 }),
      createLogEntry({ type: 'tool', content: 'b', toolName: 'read_file', turnNumber: 1 }),
      createLogEntry({ type: 'tool', content: 'c', toolName: 'grep', turnNumber: 1 }),
      createLogEntry({ type: 'tool', content: 'd', toolName: 'write_file', turnNumber: 1 }),
      createLogEntry({ type: 'assistant_message', content: 'done', turnNumber: 1 }),
    ]
    const result = groupLogs(items)
    assert.equal(result.length, 6)
  })

  it('groups 5+ consecutive tool entries into tool_group', () => {
    const items = [
      createLogEntry({ type: 'user_message', content: 'hi', turnNumber: 1 }),
      createLogEntry({ type: 'tool', content: 'a', toolName: 'read_file', turnNumber: 1 }),
      createLogEntry({ type: 'tool', content: 'b', toolName: 'read_file', turnNumber: 1 }),
      createLogEntry({ type: 'tool', content: 'c', toolName: 'grep', turnNumber: 1 }),
      createLogEntry({ type: 'tool', content: 'd', toolName: 'write_file', turnNumber: 1 }),
      createLogEntry({ type: 'tool', content: 'e', toolName: 'bash', turnNumber: 1 }),
      createLogEntry({ type: 'assistant_message', content: 'done', turnNumber: 1 }),
    ]
    const result = groupLogs(items)
    assert.equal(result.length, 3)
    assert.equal(result[1]!.type, 'tool_group')
    assert.equal(result[1]!.children!.length, 5)
  })

  it('does not group tools from different turns', () => {
    const items = [
      createLogEntry({ type: 'tool', content: 'a', toolName: 'read_file', turnNumber: 1 }),
      createLogEntry({ type: 'tool', content: 'b', toolName: 'read_file', turnNumber: 1 }),
      createLogEntry({ type: 'tool', content: 'c', toolName: 'read_file', turnNumber: 1 }),
      createLogEntry({ type: 'tool', content: 'd', toolName: 'read_file', turnNumber: 1 }),
      createLogEntry({ type: 'tool', content: 'e', toolName: 'read_file', turnNumber: 1 }),
      createLogEntry({ type: 'assistant_message', content: 'done', turnNumber: 1 }),
      createLogEntry({ type: 'tool', content: 'f', toolName: 'grep', turnNumber: 2 }),
      createLogEntry({ type: 'tool', content: 'g', toolName: 'grep', turnNumber: 2 }),
      createLogEntry({ type: 'tool', content: 'h', toolName: 'read_file', turnNumber: 2 }),
      createLogEntry({ type: 'tool', content: 'i', toolName: 'read_file', turnNumber: 2 }),
      createLogEntry({ type: 'tool', content: 'j', toolName: 'read_file', turnNumber: 2 }),
    ]
    const result = groupLogs(items)
    // Turn 1: 5 tools → grouped into 1 tool_group
    // assistant_message → separate
    // Turn 2: 5 tools → grouped into 1 tool_group
    assert.equal(result.length, 3)
    assert.equal(result[0]!.type, 'tool_group')
    assert.equal(result[0]!.children!.length, 5)
    assert.equal(result[1]!.type, 'assistant_message')
    assert.equal(result[2]!.type, 'tool_group')
    assert.equal(result[2]!.children!.length, 5)
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
      createLogEntry({ type: 'tool', content: 'd', toolName: 'read_file', turnNumber: 1 }),
      createLogEntry({ type: 'tool', content: 'e', toolName: 'read_file', turnNumber: 1 }),
    ]
    const result = groupLogs(items)
    assert.equal(result.length, 2)
    assert.equal(result[1]!.type, 'tool_group')
    assert.equal(result[1]!.children!.length, 5)
  })

  it('groups tools without turnNumber', () => {
    const items = [
      createLogEntry({ type: 'tool', content: 'a', toolName: 'read_file' }),
      createLogEntry({ type: 'tool', content: 'b', toolName: 'read_file' }),
      createLogEntry({ type: 'tool', content: 'c', toolName: 'read_file' }),
      createLogEntry({ type: 'tool', content: 'd', toolName: 'read_file' }),
      createLogEntry({ type: 'tool', content: 'e', toolName: 'read_file' }),
    ]
    const result = groupLogs(items)
    assert.equal(result.length, 1)
    assert.equal(result[0]!.type, 'tool_group')
    assert.equal(result[0]!.children!.length, 5)
  })
})
