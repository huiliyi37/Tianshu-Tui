import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport, getDefaultEnvironment } from '@modelcontextprotocol/sdk/client/stdio.js'
import type { Tool } from '../tools/types.js'
import type { McpConfig, McpServerConfig } from './config.js'
import type { McpConnectionState } from './types.js'
import { createMcpToolWrapper } from './wrapper.js'

const DEFAULT_MCP_TIMEOUT_MS = 15_000

function withTimeout<T>(promise: Promise<T>, label: string, timeoutMs: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${label} timed out after ${timeoutMs}ms`)), timeoutMs)
    promise.then(
      value => { clearTimeout(timer); resolve(value) },
      error => { clearTimeout(timer); reject(error) },
    )
  })
}

export interface McpToolDef {
  name: string
  description?: string
  inputSchema: {
    type: 'object'
    properties?: Record<string, unknown>
    required?: string[]
  }
}

export interface ConnectedServer {
  client: Client
  transport: { close(): Promise<void> }
  serverId: string
}

export class McpManager {
  private config: McpConfig
  private connections: Map<string, ConnectedServer> = new Map()
  private states: Map<string, McpConnectionState> = new Map()
  private tools: Tool[] = []
  private timeoutMs: number

  constructor(config: McpConfig) {
    this.config = config
    this.timeoutMs = config.timeoutMs ?? DEFAULT_MCP_TIMEOUT_MS
  }

  async initialize(): Promise<void> {
    if (!this.config.enabled) return

    const entries = Object.entries(this.config.servers)
      .filter(([, cfg]) => !cfg.disabled)

    await Promise.allSettled(
      entries.map(([serverId, serverConfig]) =>
        this.connectAndDiscover(serverId, serverConfig),
      ),
    )
  }

  getAllTools(): Tool[] {
    return this.tools
  }

  getStates(): McpConnectionState[] {
    return Array.from(this.states.values())
  }

  async shutdown(): Promise<void> {
    const closePromises = Array.from(this.connections.values()).map(async (conn) => {
      try {
        await conn.transport.close()
      } catch {
        // Best-effort close
      }
    })
    await Promise.all(closePromises)
    this.connections.clear()
    this.states.clear()
    this.tools = []
  }

  /**
   * Synchronous force-kill of MCP child processes — for the process-exit path.
   *
   * `shutdown()` is async (`await transport.close()`); on `process.exit(0)` that
   * promise is abandoned before it runs, so the spawned MCP server only receives
   * stdin-EOF. Well-behaved servers exit on EOF, but misbehaving ones (e.g.
   * lark-mcp) linger as PPID=1 orphans. StdioClientTransport exposes the child
   * pid, so we SIGKILL the process group inline before exiting.
   * (root-cause analysis 2026-06-05, Thread 1A)
   */
  killChildrenSync(): void {
    for (const conn of this.connections.values()) {
      const pid = (conn.transport as { pid?: number | null }).pid
      if (typeof pid === 'number' && pid > 0) {
        try { process.kill(-pid, 'SIGKILL') } catch {
          try { process.kill(pid, 'SIGKILL') } catch { /* already gone */ }
        }
      }
    }
    this.connections.clear()
  }

  private async connectAndDiscover(serverId: string, serverConfig: McpServerConfig): Promise<void> {
    this.states.set(serverId, {
      serverId,
      status: 'connecting',
      toolCount: 0,
    })

    try {
      const server = await this._connectServer(serverId, serverConfig)
      this.connections.set(serverId, server)

      try {
        const mcpTools = await this._discoverTools(serverId, server)

        const rivetTools = mcpTools.map(mcpDef => {
          const perToolCallFn = async (input: Record<string, unknown>) => {
            if (!this.connections.has(serverId)) {
              throw new Error(`MCP server "${serverId}" is disconnected`)
            }
            try {
              const result = await withTimeout(
                server.client.callTool({ name: mcpDef.name, arguments: input }),
                `MCP callTool ${serverId}/${mcpDef.name}`,
                this.timeoutMs,
              )
              const textContent = (result.content as Array<{ type: string; text?: string }>)
                .filter((c): c is { type: 'text'; text: string } =>
                  c.type === 'text' && typeof c.text === 'string')
              return {
                content: textContent,
                isError: result.isError as boolean | undefined,
              }
            } catch (err) {
              const current = this.states.get(serverId)
              this.states.set(serverId, {
                serverId,
                status: 'degraded',
                toolCount: current?.toolCount ?? 0,
                error: err instanceof Error ? err.message : String(err),
                lastConnectedAt: current?.lastConnectedAt,
                lastErrorAt: Date.now(),
              })
              throw err
            }
          }
          return createMcpToolWrapper(serverId, mcpDef, perToolCallFn)
        })

        this.tools.push(...rivetTools)
        this.states.set(serverId, {
          serverId,
          status: 'connected',
          toolCount: mcpTools.length,
          lastConnectedAt: Date.now(),
        })
      } catch (err) {
        // Tool discovery failed — close the transport that was just opened
        try { await server.transport.close() } catch { /* best-effort */ }
        this.connections.delete(serverId)
        throw err
      }
    } catch (err) {
      this.states.set(serverId, {
        serverId,
        status: 'error',
        toolCount: 0,
        error: err instanceof Error ? err.message : String(err),
      })
    }
  }

  /** @internal Overridable for testing */
  async _connectServer(serverId: string, config?: McpServerConfig): Promise<ConnectedServer> {
    const cfg = config ?? this.config.servers[serverId]!
    const client = new Client(
      { name: 'rivet', version: '0.1.0' },
      { capabilities: {} },
    )

    if (cfg.command) {
      const transport = new StdioClientTransport({
        command: cfg.command,
        args: cfg.args,
        env: cfg.env ? { ...getDefaultEnvironment(), ...cfg.env } as Record<string, string> : undefined,
        cwd: cfg.cwd,
        stderr: 'pipe',
      })
      await withTimeout(client.connect(transport), `MCP connect ${serverId}`, this.timeoutMs)
      return { client, transport, serverId }
    } else if (cfg.url) {
      const { StreamableHTTPClientTransport } = await import(
        '@modelcontextprotocol/sdk/client/streamableHttp.js'
      ) as typeof import('@modelcontextprotocol/sdk/client/streamableHttp.js')
      const transport = new StreamableHTTPClientTransport(
        new URL(cfg.url),
        {
          requestInit: cfg.headers ? { headers: cfg.headers as Record<string, string> } : undefined,
        },
      )
      await withTimeout(client.connect(transport), `MCP connect ${serverId}`, this.timeoutMs)
      return { client, transport, serverId }
    }

    throw new Error(`Invalid MCP server config for ${serverId}`)
  }

  /** @internal Overridable for testing */
  async _discoverTools(serverId: string, server?: ConnectedServer): Promise<McpToolDef[]> {
    const conn = server ?? this.connections.get(serverId)
    if (!conn) return []
    const result = await withTimeout(conn.client.listTools(), `MCP listTools ${serverId}`, this.timeoutMs)
    return result.tools.map(t => ({
      name: t.name,
      description: t.description,
      inputSchema: (t.inputSchema ?? { type: 'object' as const, properties: {} }) as McpToolDef['inputSchema'],
    }))
  }
}
