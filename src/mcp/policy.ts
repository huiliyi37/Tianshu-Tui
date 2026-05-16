export type McpCapability = 'read' | 'write' | 'execute' | 'network'
export type McpPolicyAction = 'allow' | 'confirm' | 'block' | 'require'

export interface McpPolicyInput {
  toolName: string
  trustedServers: string[]
  blockedTools: string[]
  allowedTools: string[]
  mustConfirmCapabilities: McpCapability[]
}

export interface McpPolicyDecision {
  action: McpPolicyAction
  serverId?: string
  mcpToolName?: string
  capability: McpCapability
  reason: string
}

const WRITE_RE = /(?:^|[_-])(?:write|create|update|delete|remove|push|post|put|patch)(?:$|[_-])/i
const EXECUTE_RE = /(?:^|[_-])(?:execute|run|shell|bash|command)(?:$|[_-])/i
const NETWORK_RE = /(?:^|[_-])(?:fetch|request|http|web|download|upload)(?:$|[_-])/i

function parseMcpTool(toolName: string): { serverId: string; mcpToolName: string } | null {
  const match = toolName.match(/^mcp__(.+)__(.+)$/)
  if (!match) return null
  return { serverId: match[1]!, mcpToolName: match[2]! }
}

function inferCapability(mcpToolName: string): McpCapability {
  if (EXECUTE_RE.test(mcpToolName)) return 'execute'
  if (WRITE_RE.test(mcpToolName)) return 'write'
  if (NETWORK_RE.test(mcpToolName)) return 'network'
  return 'read'
}

export function evaluateMcpPolicy(input: McpPolicyInput): McpPolicyDecision {
  const parsed = parseMcpTool(input.toolName)
  if (!parsed) {
    return { action: 'allow', capability: 'read', reason: 'Not an MCP tool.' }
  }

  const capability = inferCapability(parsed.mcpToolName)

  if (input.blockedTools.includes(input.toolName)) {
    return { action: 'block', ...parsed, capability, reason: 'MCP tool is explicitly blocked.' }
  }

  if (input.allowedTools.includes(input.toolName)) {
    return { action: 'allow', ...parsed, capability, reason: 'MCP tool is explicitly allowed.' }
  }

  const trusted = input.trustedServers.includes(parsed.serverId)
  if (!trusted && capability !== 'read') {
    return { action: 'confirm', ...parsed, capability, reason: `MCP server ${parsed.serverId} is unknown and requests ${capability} capability.` }
  }

  if (input.mustConfirmCapabilities.includes(capability)) {
    return { action: 'confirm', ...parsed, capability, reason: `MCP ${capability} capability requires confirmation.` }
  }

  return { action: 'allow', ...parsed, capability, reason: 'MCP policy allows this tool.' }
}
