/**
 * /mcp/* routes — MCP server management for the desktop settings UI.
 * All routes are Bearer-gated (fail-closed).
 *
 *   GET    /mcp/status                  list all MCP servers + connection states
 *   POST   /mcp/servers                 add/update an MCP server
 *   DELETE /mcp/servers/:id             remove an MCP server
 *   POST   /mcp/servers/:id/restart     disconnect + reconnect a server
 *   GET    /mcp/servers/:id/tools       list tools for a specific server
 */
import type { RouteHandler } from './index.js'
import { isAuthorizedRequest } from './auth.js'
import { loadConfig, saveConfig } from '../config/manager.js'
import type { McpManager } from '../mcp/manager.js'
import { mcpServerConfigSchema, type McpServerConfig } from '../mcp/config.js'
import { MCP_PRESETS } from '../mcp/presets.js'
import { serverLogger } from './logger.js'

function withAuth(handler: RouteHandler, apiToken?: string): RouteHandler {
  return async (body, params, headers, res) => {
    if (!isAuthorizedRequest({ body, headers }, apiToken)) {
      return { status: 401, body: { error: 'Unauthorized' } }
    }
    return handler(body, params, headers, res)
  }
}

function cloneMcpServers(): Record<string, McpServerConfig> {
  const cfg = loadConfig()
  return { ...cfg.mcp?.servers ?? {} }
}

function persistMcpServers(servers: Record<string, McpServerConfig>): void {
  const cfg = loadConfig()
  cfg.mcp.servers = servers
  saveConfig(cfg)
}

export function buildMcpRoutes(
  getMcpManager: () => McpManager | null,
  apiToken?: string,
): Record<string, RouteHandler> {
  return {
    // GET /mcp/status — live connection states from the running McpManager.
    'GET /mcp/status': withAuth(() => {
      const mgr = getMcpManager()
      const servers = mgr ? mgr.getStates() : []
      const configServers = cloneMcpServers()
      // Merge config entries for servers that haven't connected yet
      const seen = new Set(servers.map(s => s.serverId))
      for (const [id, cfg] of Object.entries(configServers)) {
        if (!seen.has(id)) {
          servers.push({
            serverId: id,
            status: cfg.disabled ? 'disconnected' : 'disconnected',
            transport: cfg.command ? 'stdio' : 'sse',
            toolCount: 0,
          })
        }
      }
      return {
        status: 200,
        body: {
          servers,
          totalTools: servers.reduce((s, c) => s + c.toolCount, 0),
          enabled: loadConfig().mcp?.enabled ?? true,
        },
      }
    }, apiToken),

    // GET /mcp/presets — curated one-click MCP catalog + which ids are already
    // configured (mirrors provider `unconfigured` so the UI can render add state).
    'GET /mcp/presets': withAuth(() => {
      const configuredIds = Object.keys(cloneMcpServers())
      return { status: 200, body: { presets: MCP_PRESETS, configuredIds } }
    }, apiToken),

    // POST /mcp/servers — add or update an MCP server config.
    'POST /mcp/servers': withAuth((body) => {
      const input = body as Record<string, unknown>
      const serverId = typeof input.serverId === 'string' ? input.serverId : undefined
      if (!serverId) return { status: 400, body: { error: 'serverId is required' } }

      const configInput: Record<string, unknown> = {}
      if (typeof input.command === 'string') configInput.command = input.command
      if (Array.isArray(input.args)) configInput.args = input.args
      if (typeof input.url === 'string') configInput.url = input.url
      if (typeof input.disabled === 'boolean') configInput.disabled = input.disabled
      if (input.env && typeof input.env === 'object') configInput.env = input.env as Record<string, string>
      if (input.headers && typeof input.headers === 'object') configInput.headers = input.headers as Record<string, string>
      if (typeof input.cwd === 'string') configInput.cwd = input.cwd

      const parsed = mcpServerConfigSchema.safeParse(configInput)
      if (!parsed.success) {
        return { status: 400, body: { error: parsed.error.issues.map(i => i.message).join('; ') } }
      }

      const servers = cloneMcpServers()
      servers[serverId] = parsed.data
      persistMcpServers(servers)

      // If manager is live, try connecting immediately.
      const mgr = getMcpManager()
      if (mgr && !parsed.data.disabled) {
        void mgr.connectAndDiscover(serverId, parsed.data).catch((err: Error) => {
          serverLogger.warn(`MCP auto-connect failed for ${serverId}: ${err.message}`)
        })
      }

      return { status: 200, body: { ok: true, serverId } }
    }, apiToken),

    // DELETE /mcp/servers/:id — remove an MCP server from config.
    'DELETE /mcp/servers/:id': withAuth(async (_, params) => {
      const serverId = params?.id
      if (!serverId) return { status: 400, body: { error: 'server id is required' } }

      const servers = cloneMcpServers()
      if (!servers[serverId]) {
        return { status: 404, body: { error: `MCP server "${serverId}" not found` } }
      }
      delete servers[serverId]
      persistMcpServers(servers)

      const mgr = getMcpManager()
      if (mgr) {
        await mgr.shutdownServer(serverId).catch(() => {})
      }

      return { status: 200, body: { ok: true, removed: serverId } }
    }, apiToken),

    // POST /mcp/servers/:id/restart — disconnect and reconnect a server.
    'POST /mcp/servers/:id/restart': withAuth(async (_, params) => {
      const serverId = params?.id
      if (!serverId) return { status: 400, body: { error: 'server id is required' } }

      const mgr = getMcpManager()
      if (!mgr) return { status: 503, body: { error: 'MCP manager not initialized' } }

      try {
        await mgr.shutdownServer(serverId)
        const cfg = loadConfig().mcp?.servers[serverId]
        if (!cfg) return { status: 404, body: { error: `MCP server "${serverId}" not found in config` } }
        if (cfg.disabled) return { status: 400, body: { error: `MCP server "${serverId}" is disabled` } }
        await mgr.connectAndDiscover(serverId, cfg)
        return { status: 200, body: { ok: true, serverId } }
      } catch (err) {
        return { status: 500, body: { error: (err as Error).message } }
      }
    }, apiToken),

    // GET /mcp/servers/:id/tools — list tools for a specific server.
    'GET /mcp/servers/:id/tools': withAuth((_, params) => {
      const serverId = params?.id
      if (!serverId) return { status: 400, body: { error: 'server id is required' } }

      const mgr = getMcpManager()
      if (!mgr) return { status: 503, body: { error: 'MCP manager not initialized' } }

      const allTools = mgr.getAllTools()
      const serverTools = allTools
        .filter(t => t.definition.name.startsWith(`mcp__${serverId}__`))
        .map(t => ({
          name: t.definition.name,
          description: t.definition.description,
          inputSchema: t.definition.input_schema,
        }))

      return { status: 200, body: { tools: serverTools } }
    }, apiToken),
  }
}
