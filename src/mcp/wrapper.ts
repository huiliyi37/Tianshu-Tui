import type { Tool, ToolCallParams, ToolResult } from '../tools/types.js'

export function mcpToolName(serverId: string, toolName: string): string {
  return `mcp__${serverId}__${toolName}`
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
      try {
        const result = await callTool(params.input)
        const textParts = result.content
          .filter((c): c is { type: 'text'; text: string } => c.type === 'text')
          .map(c => c.text)
        const content = textParts.join('\n') || '(no text content)'

        return {
          content,
          ...(result.isError ? { isError: true } : {}),
        }
      } catch (err) {
        return {
          content: `MCP tool error (${rivetName}): ${err instanceof Error ? err.message : String(err)}`,
          isError: true,
        }
      }
    },

    requiresApproval(_params: ToolCallParams): boolean {
      return needsApproval
    },

    isConcurrencySafe(): boolean {
      return true
    },

    isEnabled(): boolean {
      return true
    },
  }
}
