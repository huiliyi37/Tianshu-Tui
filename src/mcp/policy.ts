export type McpCapability = 'unknown' | 'read' | 'write' | 'execute' | 'network'
export type McpPolicyAction = 'allow' | 'confirm' | 'block' | 'require'

export interface McpPolicyInput {
  toolName: string
  /** Capability declared in local MCP configuration. Undeclared tools are unknown. */
  declaredCapability?: McpCapability
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

function parseMcpTool(toolName: string): { serverId: string; mcpToolName: string } | null {
  const match = toolName.match(/^mcp__(.+)__(.+)$/)
  if (!match) return null
  return { serverId: match[1]!, mcpToolName: match[2]! }
}

export function evaluateMcpPolicy(input: McpPolicyInput): McpPolicyDecision {
  const parsed = parseMcpTool(input.toolName)
  if (!parsed) {
    return { action: 'allow', capability: 'read', reason: 'Not an MCP tool.' }
  }

  const capability = input.declaredCapability ?? 'unknown'

  if (input.blockedTools.includes(input.toolName)) {
    return {
      action: 'block',
      ...parsed,
      capability,
      // 出路契约：拦截理由必须带替代路径，被拦不是死路。
      reason: `MCP tool is explicitly blocked by user config. Not a dead end — achieve the goal via built-in tools (read_file/grep/bash) or another MCP tool, or ask the user to unblock "${parsed.mcpToolName}" if it is genuinely required.`,
    }
  }

  if (input.allowedTools.includes(input.toolName)) {
    return { action: 'allow', ...parsed, capability, reason: 'MCP tool is explicitly allowed.' }
  }

  if (capability === 'unknown') {
    return {
      action: 'confirm',
      ...parsed,
      capability,
      reason: `MCP tool ${parsed.mcpToolName} has no declared capability. Confirm each call or declare it in the server policy.`,
    }
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
