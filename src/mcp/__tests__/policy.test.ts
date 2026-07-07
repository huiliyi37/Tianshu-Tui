import test from 'node:test'
import assert from 'node:assert/strict'
import { evaluateMcpPolicy } from '../policy.js'

test('requires confirmation for unknown write-capable MCP tool', () => {
  const result = evaluateMcpPolicy({
    toolName: 'mcp__unknown__delete_file',
    trustedServers: [],
    blockedTools: [],
    allowedTools: [],
    mustConfirmCapabilities: ['write'],
  })

  assert.equal(result.action, 'confirm')
  assert.equal(result.capability, 'write')
  assert.match(result.reason, /unknown/)
})

test('blocks explicitly blocked MCP tool', () => {
  const result = evaluateMcpPolicy({
    toolName: 'mcp__github__delete_repo',
    trustedServers: ['github'],
    blockedTools: ['mcp__github__delete_repo'],
    allowedTools: [],
    mustConfirmCapabilities: ['write'],
  })

  assert.equal(result.action, 'block')
})

test('allows explicitly allowed read MCP tool', () => {
  const result = evaluateMcpPolicy({
    toolName: 'mcp__docs__search',
    trustedServers: ['docs'],
    blockedTools: [],
    allowedTools: ['mcp__docs__search'],
    mustConfirmCapabilities: ['write'],
  })

  assert.equal(result.action, 'allow')
  assert.equal(result.capability, 'read')
})
