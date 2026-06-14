import type { ApprovalRequest } from '../runtime/types'

// Approval preview helpers (Q3) — extracted from the old ApprovalModal so the
// inline review UI and any tests can share them. Pure functions.

export const EDIT_TOOLS = new Set(['edit_file', 'write_file', 'apply_patch'])

/** The input key carrying the new file content for each edit tool (if any). */
export function editableKey(req: ApprovalRequest): 'new_string' | 'content' | null {
  const input = req.input as Record<string, unknown>
  if (!EDIT_TOOLS.has(req.toolName)) return null
  if (typeof input.new_string === 'string') return 'new_string'
  if (typeof input.content === 'string') return 'content'
  return null
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
