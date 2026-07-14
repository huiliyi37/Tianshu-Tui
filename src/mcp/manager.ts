import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport, getDefaultEnvironment } from '@modelcontextprotocol/sdk/client/stdio.js'
import type { Tool } from '../tools/types.js'
import type { McpConfig, McpServerConfig } from './config.js'
import type { McpConnectionState } from './types.js'
import { createMcpToolWrapper, createMcpConnectorConsent, type McpConnectorConsent } from './wrapper.js'
import { classifyMcpError } from './failure-classifier.js'
import { resolveNpmCliCommand, buildStdioEnvWithNodePath } from '../platform/resolve-node-cli.js'

const DEFAULT_MCP_TIMEOUT_MS = 60_000
const STDERR_TAIL_MAX = 4_096
const NETWORK_RETRY_DELAY_MS = 800

function withTimeout<T>(promise: Promise<T>, label: string, timeoutMs: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${label} timed out after ${timeoutMs}ms`)), timeoutMs)
    promise.then(
      value => { clearTimeout(timer); resolve(value) },
      error => { clearTimeout(timer); reject(error) },
    )
  })
}

function trimStderrTail(chunks: string[]): string {
  let text = chunks.join('').replace(/\s+$/u, '')
  if (text.length > STDERR_TAIL_MAX) text = text.slice(-STDERR_TAIL_MAX)
  return text
}

function formatConnectError(err: unknown, stderrTail: string): string {
  const base = err instanceof Error ? err.message : String(err)
  const classified = classifyMcpError(err)
  const parts = [base]
  if (stderrTail) {
    const compact = stderrTail.replace(/\n+/g, ' | ').slice(0, 500)
    parts.push(`stderr: ${compact}`)
  }
  if (classified.suggestion) parts.push(classified.suggestion)
  return parts.join(' — ')
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
  transport: { close(): Promise<void>; pid?: number | null }
  serverId: string
  /** Last stdio stderr bytes captured during connect (for error attribution). */
  stderrTail?: () => string
}

export class McpManager {
  private config: McpConfig
  private connections: Map<string, ConnectedServer> = new Map()
  private states: Map<string, McpConnectionState> = new Map()
  private tools: Tool[] = []
  private timeoutMs: number
  // Shared across all wrappers: first use of each connector requires explicit opt-in.
  private connectorConsent: McpConnectorConsent = createMcpConnectorConsent()

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

  /**
   * Re-read a live config snapshot and connect any servers that are missing
   * from the in-memory manager — used after fire-and-forget init so a POST
   * that landed while mgr was still null still gets a connect attempt.
   * Skips currently connected/connecting entries; retries error/disconnected.
   * @returns newly registered tools from this reconcile pass
   */
  async reconcileFromConfig(live: McpConfig): Promise<Tool[]> {
    this.config = live
    this.timeoutMs = live.timeoutMs ?? DEFAULT_MCP_TIMEOUT_MS
    if (!live.enabled) return []

    const added: Tool[] = []
    for (const [serverId, cfg] of Object.entries(live.servers)) {
      if (cfg.disabled) continue
      const state = this.states.get(serverId)
      if (state?.status === 'connected' || state?.status === 'connecting') continue
      if (this.connections.has(serverId)) continue
      const before = new Set(this.tools.map((t) => t.definition.name))
      await this.connectAndDiscover(serverId, cfg)
      for (const tool of this.tools) {
        if (!before.has(tool.definition.name) && tool.definition.name.startsWith(`mcp__${serverId}__`)) {
          added.push(tool)
        }
      }
    }
    return added
  }

  getAllTools(): Tool[] {
    return this.tools
  }

  /** Tools belonging to one server (by `mcp__{id}__` prefix). */
  getToolsForServer(serverId: string): Tool[] {
    const prefix = `mcp__${serverId}__`
    return this.tools.filter((t) => t.definition.name.startsWith(prefix))
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

  /** Shut down a single server by id — for the REST API restart/remove flow. */
  async shutdownServer(serverId: string): Promise<void> {
    const conn = this.connections.get(serverId)
    if (conn) {
      try { await conn.transport.close() } catch { /* best-effort */ }
      this.connections.delete(serverId)
    }
    // Remove the server's tools from the tool list
    const prefix = `mcp__${serverId}__`
    this.tools = this.tools.filter(t => !t.definition.name.startsWith(prefix))
    this.states.delete(serverId)
  }

  /**
   * Connect and discover tools for a single server. Public so the REST API can
   * hot-add servers without a full restart.
   * @returns tools newly registered for this server (empty on failure)
   */
  async connectAndDiscover(serverId: string, serverConfig: McpServerConfig): Promise<Tool[]> {
    return this._connectAndDiscover(serverId, serverConfig, /*attempt*/ 0)
  }

  private async _connectAndDiscover(
    serverId: string,
    serverConfig: McpServerConfig,
    attempt: number,
  ): Promise<Tool[]> {
    const transport: 'stdio' | 'sse' = serverConfig.command ? 'stdio' : 'sse'
    this.states.set(serverId, {
      serverId,
      status: 'connecting',
      transport,
      toolCount: 0,
    })

    let stderrTail = ''
    try {
      const server = await this._connectServer(serverId, serverConfig)
      stderrTail = server.stderrTail?.() ?? ''
      this.connections.set(serverId, server)

      try {
        // Drop prior tools for this server (restart / re-reconcile path).
        const prefix = `mcp__${serverId}__`
        this.tools = this.tools.filter((t) => !t.definition.name.startsWith(prefix))

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
              const classified = classifyMcpError(err)
              const current = this.states.get(serverId)
              this.states.set(serverId, {
                serverId,
                transport,
                status: 'degraded',
                toolCount: current?.toolCount ?? 0,
                error: formatConnectError(err, ''),
                errorHint: classified.suggestion,
                lastConnectedAt: current?.lastConnectedAt,
                lastErrorClass: classified.class,
                lastErrorAt: Date.now(),
              })
              throw err
            }
          }
          return createMcpToolWrapper(serverId, mcpDef, perToolCallFn, this.connectorConsent)
        })

        this.tools.push(...rivetTools)
        this.states.set(serverId, {
          serverId,
          transport,
          status: 'connected',
          toolCount: mcpTools.length,
          lastConnectedAt: Date.now(),
        })
        return rivetTools
      } catch (err) {
        // Tool discovery failed — close the transport that was just opened
        try { await server.transport.close() } catch { /* best-effort */ }
        this.connections.delete(serverId)
        throw err
      }
    } catch (err) {
      const classified = classifyMcpError(err)
      // One automatic backoff retry for transient/network failures.
      if (classified.retryable && attempt === 0) {
        await new Promise((r) => setTimeout(r, NETWORK_RETRY_DELAY_MS))
        return this._connectAndDiscover(serverId, serverConfig, 1)
      }
      this.states.set(serverId, {
        serverId,
        transport,
        status: 'error',
        toolCount: 0,
        error: formatConnectError(err, stderrTail),
        errorHint: classified.suggestion,
        lastErrorClass: classified.class,
        lastErrorAt: Date.now(),
      })
      return []
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
      // MCP SDK hardcodes shell:false — rewrite bare npx/npm to node+cli.js so
      // Windows GUI / bundled-node launches don't ENOENT on npx.cmd.
      const resolved = resolveNpmCliCommand(cfg.command, cfg.args ?? [])
      const bare = cfg.command.replace(/\\/g, '/').split('/').pop()?.replace(/\.(cmd|bat|exe)$/i, '').toLowerCase()
      const fellBackToBareNpx = (bare === 'npx' || bare === 'npm')
        && resolved.command === cfg.command
      const env = buildStdioEnvWithNodePath(
        cfg.env as Record<string, string> | undefined,
        { getDefaultEnvironment },
      )
      const transport = new StdioClientTransport({
        command: resolved.command,
        args: resolved.args,
        env,
        cwd: cfg.cwd,
        stderr: 'pipe',
      })
      // Attach stderr listeners BEFORE connect so early bootstrap errors are kept.
      const stderrChunks: string[] = []
      const stderrStream = transport.stderr as { on?(event: string, cb: (chunk: Buffer | string) => void): void } | null
      if (stderrStream && typeof stderrStream.on === 'function') {
        stderrStream.on('data', (chunk: Buffer | string) => {
          const text = typeof chunk === 'string' ? chunk : chunk.toString('utf8')
          stderrChunks.push(text)
          while (stderrChunks.join('').length > STDERR_TAIL_MAX) stderrChunks.shift()
        })
      }
      try {
        await withTimeout(client.connect(transport), `MCP connect ${serverId}`, this.timeoutMs)
      } catch (err) {
        if (fellBackToBareNpx) {
          const msg = err instanceof Error ? err.message : String(err)
          throw new Error(
            `${msg} — npx/npm-cli.js was not found next to this Node binary `
            + `(${process.execPath}); packaged builds need fetch-node-runtime to bundle npm`,
          )
        }
        throw err
      }
      return {
        client,
        transport,
        serverId,
        stderrTail: () => trimStderrTail(stderrChunks),
      }
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
