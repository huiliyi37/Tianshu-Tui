/**
 * Pre-compact handoff: generate a compact session summary before compaction.
 * This preserves critical context (files modified, recent tool calls, failures)
 * so the agent can recover state after compaction.
 *
 * Design: docs/superpowers/plans/2026-05-24-token-optimization-scout-findings.md
 */

import type { OaiMessage } from '../api/oai-types.js'

export interface HandoffResult {
  summary: string
  filesModified: string[]
  hadFailures: boolean
}

/**
 * Generate a compact handoff summary from session messages.
 * Extracts files modified, recent tool calls, and failure status.
 */
export function generateHandoff(messages: OaiMessage[]): HandoffResult {
  const filesModified = new Set<string>()
  const toolCalls: { name: string; ok: boolean }[] = []
  let hadFailures = false

  for (const msg of messages) {
    if (msg.role === 'tool') {
      const input = (msg as any).input
      const name = (msg as any).name ?? ''
      const isError = (msg as any).isError ?? false
      if (isError) hadFailures = true
      toolCalls.push({ name, ok: !isError })

      const filePath = input?.file_path ?? input?.path
      if (filePath && (name === 'edit_file' || name === 'write_file')) {
        filesModified.add(filePath)
      }
    }
  }

  // Build compact summary
  const parts: string[] = []

  if (filesModified.size > 0) {
    const files = [...filesModified].slice(0, 10)
    parts.push(`files_modified: [${files.join(', ')}]`)
  }

  // Last 5 tool calls
  const recent = toolCalls.slice(-5)
  if (recent.length > 0) {
    const calls = recent.map(t => `${t.name}${t.ok ? '' : '(FAIL)'}`).join(', ')
    parts.push(`recent_tools: ${calls}`)
  }

  parts.push(`had_failures: ${hadFailures}`)
  parts.push(`total_tool_calls: ${toolCalls.length}`)

  const summary = parts.join('\n')
  return { summary, filesModified: [...filesModified], hadFailures }
}
