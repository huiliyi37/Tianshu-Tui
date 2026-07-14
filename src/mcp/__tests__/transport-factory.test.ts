// transport-factory.test.ts — unit tests for config routing and error paths.
// Full transport lifecycle is covered by manager.test.ts via mock overrides.
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { createTransport, resolveTransportType } from '../transport-factory.js'
import type { McpServerConfig } from '../config.js'

describe('resolveTransportType', () => {
  it('returns stdio when command is present', () => {
    const cfg: McpServerConfig = { command: 'node', args: ['-e', '0'] } as McpServerConfig
    assert.equal(resolveTransportType(cfg), 'stdio')
  })

  it('returns streamableHttp when url is present and no hint', () => {
    const cfg: McpServerConfig = { url: 'http://localhost:8080/mcp' } as McpServerConfig
    assert.equal(resolveTransportType(cfg), 'streamableHttp')
  })

  it('returns sse-legacy when url is present and transportHint is sse', () => {
    const cfg: McpServerConfig = { url: 'http://localhost:8080/mcp', transportHint: 'sse' } as McpServerConfig
    assert.equal(resolveTransportType(cfg), 'sse-legacy')
  })
})

describe('createTransport', () => {
  it('rejects server config with neither command nor url', async () => {
    const cfg: McpServerConfig = { env: { FOO: 'bar' } } as McpServerConfig
    await assert.rejects(
      () => createTransport(cfg),
      /MCP server config must have either "command" \(stdio\) or "url"/,
    )
  })
})
