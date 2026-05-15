import type { ToolDefinition } from '../api/types.js'

export interface ToolCallParams {
  input: Record<string, unknown>
  toolUseId: string
  cwd: string
  onOutput?: (chunk: string) => void
}

export interface VerificationMetadata {
  command: string
  status: 'passed' | 'failed' | 'blocked'
  scope: 'full' | 'targeted'
  exitCode: number
  passed: number
  failed: number
  skipped: number
  durationMs: number
}

export interface ToolResult {
  /** Content sent to model as tool_result */
  content: string
  /** UI summary override — falls back to content if not provided */
  uiContent?: string
  /** Path to persisted raw output file */
  rawPath?: string
  isError?: boolean
  verification?: VerificationMetadata
}

export interface Tool {
  definition: ToolDefinition
  execute(params: ToolCallParams): Promise<ToolResult>
  requiresApproval(params: ToolCallParams): boolean
  isConcurrencySafe(): boolean
  isEnabled(): boolean
}
