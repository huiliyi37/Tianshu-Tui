import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { McpManager } from '../manager.js'
import type { McpServerConfig, McpConfig } from '../config.js'

function makeConfig(servers: Record<string, McpServerConfig> = {}): McpConfig {
  return { enabled: true, servers }
}

describe('McpManager', () => {
  it('starts with no connections', () => {
    const mgr = new McpManager(makeConfig())
    assert.deepEqual(mgr.getStates(), [])
    assert.deepEqual(mgr.getAllTools(), [])
  })

  it('skip initialization when disabled', async () => {
    const mgr = new McpManager({ enabled: false, servers: {} })
    await mgr.initialize()
    assert.deepEqual(mgr.getStates(), [])
  })

  it('registers discovered tools via mock', async () => {
    const mgr = new McpManager(makeConfig({
      echo: { command: 'node', args: ['echo-server.js'] },
    }))

    mgr['_connectServer'] = async () => ({
      client: { listTools: async () => ({ tools: [] }) } as any,
      transport: { close: async () => {} },
      serverId: 'echo',
    })
    mgr['_discoverTools'] = async () => [{
      name: 'echo',
      description: 'Echo input',
      inputSchema: { type: 'object' as const, properties: { text: { type: 'string' } } },
    }]

    await mgr.initialize()
    const tools = mgr.getAllTools()
    assert.equal(tools.length, 1)
    assert.equal(tools[0]!.definition.name, 'mcp__echo__echo')
  })

  it('skips disabled servers', async () => {
    const mgr = new McpManager(makeConfig({
      off: { command: 'node', args: ['off.js'], disabled: true },
    }))

    let connected = false
    mgr['_connectServer'] = async () => {
      connected = true
      return { client: {} as any, transport: { close: async () => {} }, serverId: 'off' }
    }

    await mgr.initialize()
    assert.equal(connected, false)
  })

  it('reports connection states', async () => {
    const mgr = new McpManager(makeConfig({
      echo: { command: 'node', args: ['echo.js'] },
    }))

    mgr['_connectServer'] = async () => ({
      client: {} as any,
      transport: { close: async () => {} },
      serverId: 'echo',
    })
    mgr['_discoverTools'] = async () => [{
      name: 'test', description: 'Test', inputSchema: { type: 'object' as const, properties: {} },
    }]

    await mgr.initialize()
    const states = mgr.getStates()
    assert.equal(states.length, 1)
    assert.equal(states[0]!.serverId, 'echo')
    assert.equal(states[0]!.status, 'connected')
    assert.equal(states[0]!.toolCount, 1)
  })

  it('handles connection failure gracefully', async () => {
    const mgr = new McpManager(makeConfig({
      broken: { command: 'nonexistent-binary' },
    }))

    mgr['_connectServer'] = async () => {
      throw new Error('spawn nonexistent-binary ENOENT')
    }

    await mgr.initialize()
    const states = mgr.getStates()
    assert.equal(states.length, 1)
    assert.equal(states[0]!.status, 'error')
    assert.ok(states[0]!.error!.includes('ENOENT'))
  })

  it('shuts down all connections', async () => {
    const mgr = new McpManager(makeConfig({
      echo: { command: 'node', args: ['echo.js'] },
    }))

    let closed = false
    mgr['_connectServer'] = async () => ({
      client: {} as any,
      transport: { close: async () => { closed = true } },
      serverId: 'echo',
    })
    mgr['_discoverTools'] = async () => []

    await mgr.initialize()
    await mgr.shutdown()
    assert.equal(closed, true)
    assert.deepEqual(mgr.getStates(), [])
  })
})
