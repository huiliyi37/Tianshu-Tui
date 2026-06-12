import type { Tool, ToolCallParams } from './types.js'
import type { FileHistory } from '../agent/file-history.js'
import { trackFileRestore } from '../agent/recovery-stack.js'

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
        // B1: note if any files are not owned by the current task
        const unownedFiles = params.ownedFiles?.length
          ? stats.filesChanged.filter(f => !params.ownedFiles!.includes(f))
          : []
        const unownedNote = unownedFiles.length > 0
          ? `\n\n⚠️  Warning: ${unownedFiles.length} file(s) are not owned by the current task and may belong to a parallel session:\n${unownedFiles.map(f => `  - ${f}`).join('\n')}\nVerify ownership before confirming.`
          : ''
        return {
          content: `Preview: ${stats.filesChanged.length} file(s) would be restored:\n${fileList}\n+${stats.insertions}/-${stats.deletions} lines${unownedNote}\n\nCall with confirm: true to execute.`,
        }
      }

      try {
        const restored = await history.rewind(latestId)
        if (restored.length === 0) {
          return { content: 'No files needed restoration.' }
        }
        for (const file of restored) {
          trackFileRestore(params.cwd, file, 'undo tool restore')
        }
        // B1: report if any restored files were not owned
        const unownedRestored = params.ownedFiles?.length
          ? restored.filter(f => !params.ownedFiles!.includes(f))
          : []
        const unownedNote = unownedRestored.length > 0
          ? `\n⚠️  ${unownedRestored.length} file(s) were not owned by this task: ${unownedRestored.join(', ')}`
          : ''
        return { content: `Restored ${restored.length} file(s):\n${restored.map(f => `  - ${f}`).join('\n')}${unownedNote}` }
      } catch (err) {
        return { content: `Undo failed: ${err instanceof Error ? err.message : String(err)}`, isError: true }
      }
    },

    requiresApproval: () => true,
    isConcurrencySafe: () => false,
    isEnabled: () => true,
  }
}
