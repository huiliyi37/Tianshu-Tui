import test from 'node:test'
import assert from 'node:assert/strict'
import { evaluateMcpPolicy } from '../policy.js'

test('requires confirmation for MCP tools without a declared capability', () => {
  const result = evaluateMcpPolicy({
    toolName: 'mcp__unknown__delete_file',
    trustedServers: [],
    blockedTools: [],
    allowedTools: [],
    mustConfirmCapabilities: ['write', 'execute', 'network'],
  })

  assert.equal(result.action, 'confirm')
  assert.equal(result.capability, 'unknown')
  assert.match(result.reason, /no declared capability/)
})

test('uses the declared capability instead of guessing from the tool name', () => {
  const result = evaluateMcpPolicy({
    toolName: 'mcp__unknown__mutate',
    declaredCapability: 'write',
    trustedServers: [],
    blockedTools: [],
    allowedTools: [],
    mustConfirmCapabilities: ['write', 'execute', 'network'],
  })

  assert.equal(result.action, 'confirm')
  assert.equal(result.capability, 'write')
})

test('blocks explicitly blocked MCP tool', () => {
  const result = evaluateMcpPolicy({
    toolName: 'mcp__github__delete_repo',
    declaredCapability: 'write',
    trustedServers: ['github'],
    blockedTools: ['mcp__github__delete_repo'],
    allowedTools: [],
    mustConfirmCapabilities: ['write', 'execute', 'network'],
  })

  assert.equal(result.action, 'block')
})

test('allows explicitly allowed read MCP tool', () => {
  const result = evaluateMcpPolicy({
    toolName: 'mcp__docs__search',
    declaredCapability: 'read',
    trustedServers: ['docs'],
    blockedTools: [],
    allowedTools: ['mcp__docs__search'],
    mustConfirmCapabilities: ['write', 'execute', 'network'],
  })

  assert.equal(result.action, 'allow')
  assert.equal(result.capability, 'read')
})
