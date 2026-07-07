import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { McpManager } from '../manager.js'
import type { McpServerConfig, McpConfig } from '../config.js'

function makeConfig(servers: Record<string, McpServerConfig> = {}): McpConfig {
  return { enabled: true, servers }
}

function wait(ms: number): Promise<'hung'> {
  return new Promise(resolve => setTimeout(() => resolve('hung'), ms))
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

  it('marks server error when tool discovery times out', async () => {
    class HangingManager extends McpManager {
      async _connectServer(serverId: string): Promise<any> {
        return {
          serverId,
          transport: { close: async () => {} },
          client: { listTools: () => new Promise(() => {}) },
        }
      }
    }

    const mgr = new HangingManager({
      enabled: true,
      servers: { slow: { command: 'node', args: ['slow.js'] } },
      timeoutMs: 10,
    } as any)

    const outcome = await Promise.race([mgr.initialize().then(() => 'done' as const), wait(100)])

    assert.equal(outcome, 'done')
    const state = mgr.getStates().find(s => s.serverId === 'slow')
    assert.equal(state?.status, 'error')
    assert.match(state?.error ?? '', /timed out/i)
  })

  it('marks connected server degraded when callTool times out', async () => {
    const mgr = new McpManager({
      enabled: true,
      servers: { slow: { command: 'node', args: ['slow.js'] } },
      timeoutMs: 10,
    } as any)

    mgr['_connectServer'] = async (serverId: string) => ({
      serverId,
      transport: { close: async () => {} },
      client: {
        listTools: async () => ({ tools: [{ name: 'slowTool', description: 'Slow', inputSchema: { type: 'object' as const, properties: {} } }] }),
        callTool: () => new Promise(() => {}),
      } as any,
    })

    await mgr.initialize()
    const tool = mgr.getAllTools()[0]!
    const outcome = await Promise.race([
      tool.execute({ input: {}, toolUseId: 'mcp-call-timeout', cwd: process.cwd() }).then(result => ({ status: 'done' as const, result })),
      wait(100).then(() => ({ status: 'hung' as const })),
    ])

    assert.equal(outcome.status, 'done')
    if (outcome.status !== 'done') return
    assert.equal(outcome.result.isError, true)
    assert.match(outcome.result.content, /timed out/i)
    const state = mgr.getStates().find(s => s.serverId === 'slow')
    assert.equal(state?.status, 'degraded')
    assert.match(state?.error ?? '', /timed out/i)
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

  it('connects to SSE server via URL config', async () => {
    let connectedUrl = ''
    let connectedHeaders: Record<string, string> = {}

    const mgr = new McpManager(makeConfig({
      remote: { url: 'http://localhost:3001/mcp', headers: { Authorization: 'Bearer test' } },
    }))

    // Override connect & discover — mock SSE connection
    mgr['_connectServer'] = async (serverId, config) => {
      if (config && 'url' in config && config.url) {
        connectedUrl = config.url
        connectedHeaders = (config as any).headers ?? {}
        return {
          client: {} as any,
          transport: { close: async () => {} },
          serverId,
        }
      }
      throw new Error('not sse')
    }
    mgr['_discoverTools'] = async () => [{
      name: 'remote_tool',
      description: 'Remote tool via SSE',
      inputSchema: { type: 'object' as const, properties: {} },
    }]

    await mgr.initialize()
    assert.equal(connectedUrl, 'http://localhost:3001/mcp')
    assert.equal(connectedHeaders['Authorization'], 'Bearer test')
    assert.equal(mgr.getAllTools().length, 1)
    assert.equal(mgr.getAllTools()[0]!.definition.name, 'mcp__remote__remote_tool')
  })

  it('killChildrenSync force-kills MCP child pids and clears connections', async () => {
    // Regression guard (root-cause analysis 2026-06-05, Thread 1A): MCP children
    // are spawned by the SDK, not via process-tracker, so the exit path must
    // SIGKILL them by pid inline — the async shutdown() is abandoned by
    // process.exit before transport.close() runs.
    const mgr = new McpManager(makeConfig({
      echo: { command: 'node', args: ['echo.js'] },
    }))
    mgr['_connectServer'] = async () => ({
      client: {} as any,
      transport: { close: async () => {}, pid: 4242 },
      serverId: 'echo',
    })
    mgr['_discoverTools'] = async () => []
    await mgr.initialize()

    const killed: Array<{ pid: number; signal: NodeJS.Signals | number }> = []
    const origKill = process.kill
    // Spy on process.kill; swallow the call (pid 4242 doesn't exist).
    ;(process as any).kill = (pid: number, signal: NodeJS.Signals | number) => {
      killed.push({ pid, signal })
      return true
    }
    try {
      mgr.killChildrenSync()
    } finally {
      process.kill = origKill
    }

    // Process-group kill first (negative pid), SIGKILL.
    assert.ok(killed.some(k => k.pid === -4242 && k.signal === 'SIGKILL'), 'should SIGKILL the child process group')
    // Connections cleared so a later shutdown() is a no-op.
    assert.deepEqual([...(mgr as any).connections.keys()], [])
  })
})
