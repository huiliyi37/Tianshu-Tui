import type { ToolDefinition } from '../api/types.js'

export interface ToolCallParams {
  input: Record<string, unknown>
  toolUseId: string
  cwd: string
  onOutput?: (chunk: string) => void
}

export interface ToolResult {
  content: string
  isError?: boolean
}

export interface Tool {
  definition: ToolDefinition
  execute(params: ToolCallParams): Promise<ToolResult>
  requiresApproval(params: ToolCallParams): boolean
  isConcurrencySafe(): boolean
  isEnabled(): boolean
}
