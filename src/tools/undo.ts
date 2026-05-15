import type { Tool, ToolCallParams } from './types.js'
import type { FileHistory } from '../agent/file-history.js'

export function createUndoTool(getFileHistory: () => FileHistory | undefined): Tool {
  return {
    definition: {
      name: 'undo',
      description: `Undo the most recent file change by restoring it to its previous backup. Shows what would change before restoring. This operates at file level — only the files modified in the last tool call are reverted.`,
      input_schema: {
        type: 'object',
        properties: {
          confirm: {
            type: 'boolean',
            description: 'Set to true to execute the undo. Without confirm, shows preview only.',
          },
        },
      },
    },

    async execute(params: ToolCallParams) {
      const history = getFileHistory()
      if (!history) {
        return { content: 'File history not available.', isError: true }
      }

      const latestId = history.getLatestSnapshotId()
      if (!latestId) {
        return { content: 'No file history snapshots available to undo.' }
      }

      const confirm = params.input.confirm === true

      if (!confirm) {
        const stats = await history.getDiffStats(latestId)
        if (!stats || stats.filesChanged.length === 0) {
          return { content: 'No changes to undo in the most recent snapshot.' }
        }
        const fileList = stats.filesChanged.map(f => `  - ${f}`).join('\n')
        return {
          content: `Preview: ${stats.filesChanged.length} file(s) would be restored:\n${fileList}\n+${stats.insertions}/-${stats.deletions} lines\n\nCall with confirm: true to execute.`,
        }
      }

      try {
        const restored = await history.rewind(latestId)
        if (restored.length === 0) {
          return { content: 'No files needed restoration.' }
        }
        return { content: `Restored ${restored.length} file(s):\n${restored.map(f => `  - ${f}`).join('\n')}` }
      } catch (err) {
        return { content: `Undo failed: ${err instanceof Error ? err.message : String(err)}`, isError: true }
      }
    },

    requiresApproval: () => true,
    isConcurrencySafe: () => false,
    isEnabled: () => true,
  }
}
