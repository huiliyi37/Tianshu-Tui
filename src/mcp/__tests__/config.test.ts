import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { mcpServerConfigSchema, mcpConfigSchema } from '../config.js'

describe('mcpServerConfigSchema', () => {
  it('validates stdio server config', () => {
    const config = mcpServerConfigSchema.parse({
      command: 'npx',
      args: ['-y', '@modelcontextprotocol/server-filesystem', '/tmp'],
      env: { DEBUG: 'mcp:*' },
    })
    assert.equal(config.command, 'npx')
    assert.deepEqual(config.args, ['-y', '@modelcontextprotocol/server-filesystem', '/tmp'])
  })

  it('validates SSE server config', () => {
    const config = mcpServerConfigSchema.parse({
      url: 'http://localhost:3001/sse',
      headers: { Authorization: 'Bearer token123' },
    })
    assert.equal(config.url, 'http://localhost:3001/sse')
  })

  it('rejects config with neither command nor url', () => {
    assert.throws(() => mcpServerConfigSchema.parse({}), /command.*url/)
  })

  it('rejects config with both command and url', () => {
    assert.throws(() => mcpServerConfigSchema.parse({
      command: 'npx',
      url: 'http://localhost:3001/sse',
    }))
  })
})

describe('mcpConfigSchema', () => {
  it('provides defaults for empty config', () => {
    const config = mcpConfigSchema.parse({})
    assert.equal(config.enabled, true)
    assert.deepEqual(config.servers, {})
  })

  it('parses multiple server configs', () => {
    const config = mcpConfigSchema.parse({
      servers: {
        filesystem: {
          command: 'npx',
          args: ['-y', '@modelcontextprotocol/server-filesystem', '/tmp'],
        },
        github: {
          url: 'http://localhost:3001/sse',
        },
      },
    })
    assert.equal(Object.keys(config.servers).length, 2)
    assert.equal(config.servers.filesystem?.command, 'npx')
    assert.equal(config.servers.github?.url, 'http://localhost:3001/sse')
  })
})
