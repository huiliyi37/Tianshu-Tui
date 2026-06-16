import type { Tool, ToolCallParams, ToolResult } from '../tools/types.js'
import { classifyMcpError } from './failure-classifier.js'

export function mcpToolName(serverId: string, toolName: string): string {
  const safeServerId = serverId.replaceAll('__', '_')
  const safeToolName = toolName.replaceAll('__', '_')
  return `mcp__${safeServerId}__${safeToolName}`
}

/**
 * Per-session record of which MCP connectors the user has opted into.
 *
 * Borrowed from the connector opt-in principle: never silently use a connector
 * the user did not choose. The FIRST tool call from a given connector requires
 * approval; once approved (and executed), the connector's read-only tools no
 * longer prompt. Write-capable tools keep their own per-call approval.
 */
export interface McpConnectorConsent {
  hasConsented(serverId: string): boolean
  grantConsent(serverId: string): void
}

export function createMcpConnectorConsent(): McpConnectorConsent {
  const consented = new Set<string>()
  return {
    hasConsented: (serverId: string) => consented.has(serverId),
    grantConsent: (serverId: string) => { consented.add(serverId) },
  }
}

const WRITE_TOOL_PATTERNS = /\b(write|create|update|delete|remove|push|post|put|patch|execute)\b/i

interface McpToolDefinition {
  name: string
  description?: string
  inputSchema: {
    type: 'object'
    properties?: Record<string, unknown>
    required?: string[]
  }
}

interface McpCallResult {
  content: Array<{ type: 'text'; text: string } | { type: 'image'; data: string; mimeType?: string }>
  isError?: boolean
}

type CallToolFn = (input: Record<string, unknown>) => Promise<McpCallResult>

export function createMcpToolWrapper(
  serverId: string,
  mcpDef: McpToolDefinition,
  callTool: CallToolFn,
  consent?: McpConnectorConsent,
): Tool {
  const rivetName = mcpToolName(serverId, mcpDef.name)
  const desc = mcpDef.description ?? `MCP tool: ${mcpDef.name} (from ${serverId})`
  const needsApproval = WRITE_TOOL_PATTERNS.test(mcpDef.name) || WRITE_TOOL_PATTERNS.test(desc)

  return {
    definition: {
      name: rivetName,
      description: desc,
      input_schema: {
        type: 'object',
        properties: mcpDef.inputSchema.properties ?? {},
        required: mcpDef.inputSchema.required,
      },
    },

    async execute(params: ToolCallParams): Promise<ToolResult> {
      // By the time execute runs, the connector use was either approval-free or
      // approved — record the opt-in so later read-only calls don't re-prompt.
      consent?.grantConsent(serverId)
      try {
        const result = await callTool(params.input)
        const textParts = result.content
          .filter((c): c is { type: 'text'; text: string } => c.type === 'text')
          .map(c => c.text)
        const content = textParts.join('\n') || '(no text content)'

        const annotation = `[MCP: ${serverId} · ${needsApproval ? 'write-capable' : 'read-only'}]`

        return {
          content: result.isError ? `${annotation} · tool error\n${content}` : `${content}\n${annotation}`,
          ...(result.isError ? { isError: true } : {}),
        }
      } catch (err) {
        const classified = classifyMcpError(err)
        const annotation = `[MCP: ${serverId} · ${needsApproval ? 'write-capable' : 'read-only'} · error: ${classified.class} · ${classified.suggestion}]`
        return {
          content: `MCP tool error (${rivetName}): ${err instanceof Error ? err.message : String(err)}\n${annotation}`,
          isError: true,
        }
      }
    },

    requiresApproval(_params: ToolCallParams): boolean {
      // Write-capable tools always require approval. Read-only tools require a
      // one-time opt-in per connector (when a consent store is wired in).
      if (needsApproval) return true
      if (consent && !consent.hasConsented(serverId)) return true
      return false
    },

    isConcurrencySafe(): boolean {
      return true
    },

    isEnabled(): boolean {
      return true
    },
  }
}
