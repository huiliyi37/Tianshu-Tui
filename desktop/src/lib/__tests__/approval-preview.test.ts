import { test } from 'node:test'
import assert from 'node:assert/strict'
import { parseMcpToolName } from '../approval-preview.ts'

test('parseMcpToolName splits server and tool', () => {
  assert.deepEqual(parseMcpToolName('mcp__github__search_issues'), {
    serverId: 'github',
    toolName: 'search_issues',
  })
})

test('parseMcpToolName keeps inner underscores in the tool name', () => {
  // The wrapper only collapses literal `__`; a tool name with `__` is sanitized
  // to single underscores before joining, so the FIRST `__` is the separator.
  assert.deepEqual(parseMcpToolName('mcp__linear__create_issue'), {
    serverId: 'linear',
    toolName: 'create_issue',
  })
})

test('parseMcpToolName returns null for non-MCP tools', () => {
  assert.equal(parseMcpToolName('bash'), null)
  assert.equal(parseMcpToolName('edit_file'), null)
  assert.equal(parseMcpToolName('web_search'), null)
})

test('parseMcpToolName rejects malformed names', () => {
  assert.equal(parseMcpToolName('mcp__'), null)
  assert.equal(parseMcpToolName('mcp__server'), null)
  assert.equal(parseMcpToolName('mcp____tool'), null)
})
