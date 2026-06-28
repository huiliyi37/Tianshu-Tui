import type { ApprovalRequest } from '../runtime/types'

// Approval preview helpers (Q3) — extracted from the old ApprovalModal so the
// inline review UI and any tests can share them. Pure functions.

export const EDIT_TOOLS = new Set(['edit_file', 'write_file', 'apply_patch'])

export interface McpToolInfo {
  /** The connector (MCP server) the tool belongs to. */
  serverId: string
  /** The connector-local tool name (without the `mcp__server__` prefix). */
  toolName: string
}

/**
 * Parse a wrapped MCP tool name `mcp__<server>__<tool>` into its parts.
 * Returns null for non-MCP tools. The wrapper strips `__` from both the
 * server id and tool name before joining, so the FIRST `__` after the
 * `mcp__` prefix is always the server/tool separator.
 */
export function parseMcpToolName(name: string): McpToolInfo | null {
  const PREFIX = 'mcp__'
  if (!name.startsWith(PREFIX)) return null
  const rest = name.slice(PREFIX.length)
  const sep = rest.indexOf('__')
  if (sep <= 0) return null
  const serverId = rest.slice(0, sep)
  const toolName = rest.slice(sep + 2)
  if (!serverId || !toolName) return null
  return { serverId, toolName }
}

/** The input key carrying the new file content for each edit tool (if any). */
export function editableKey(req: ApprovalRequest): 'new_string' | 'content' | null {
  const input = req.input as Record<string, unknown>
  if (!EDIT_TOOLS.has(req.toolName)) return null
  if (typeof input.new_string === 'string') return 'new_string'
  if (typeof input.content === 'string') return 'content'
  return null
}

export interface ApprovalActionProps {
  /** Button class names (space-separated). */
  variant: string
  label: string
}

/**
 * Visual weights for the three approval actions.
 * Approve is the primary/recommended action; reject is danger-tinged;
 * edit is neutral ghost.
 */
export function getApprovalActionProps(
  action: 'approve' | 'reject' | 'edit',
  editing = false,
): ApprovalActionProps {
  switch (action) {
    case 'approve':
      return { variant: 'btn sm primary', label: editing ? '应用并批准' : '批准' }
    case 'reject':
      return { variant: 'btn ghost sm danger', label: '拒绝' }
    case 'edit':
      return { variant: 'btn ghost sm', label: editing ? '取消编辑' : '编辑' }
  }
}

/**
 * Readable preview of what the agent wants to do. Edit/write tools render as a
 * diff; everything else as pretty JSON.
 */
export function previewOf(req: ApprovalRequest): { isDiff: boolean; text: string } {
  const input = req.input as Record<string, unknown>
  if (EDIT_TOOLS.has(req.toolName)) {
    const oldStr = typeof input.old_string === 'string' ? input.old_string : ''
    const newStr =
      typeof input.new_string === 'string' ? input.new_string
        : typeof input.content === 'string' ? input.content : ''
    if (oldStr || newStr) {
      const path = typeof input.path === 'string' ? input.path : ''
      const body = [
        `--- ${path}`,
        `+++ ${path}`,
        ...oldStr.split('\n').map((l) => `-${l}`),
        ...newStr.split('\n').map((l) => `+${l}`),
      ].join('\n')
      return { isDiff: true, text: body }
    }
  }
  return { isDiff: false, text: JSON.stringify(req.input, null, 2) }
}
