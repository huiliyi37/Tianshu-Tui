import type { PostToolRuntimeHook, RuntimeHookContext, RuntimeToolEvent } from '../runtime-hooks.js'
import type { AdvisoryBus } from '../advisory-bus.js'

/**
 * Edit-Failure Recovery Hook — postTool detection of consecutive edit failures
 * on the same file across turns.
 *
 * When edit_file / hash_edit / write_file / ast_edit fails ≥2 times on the
 * same file, the agent's mental model is almost certainly stale. Instead of
 * retrying the same edit pattern (which leads to debris and undo loops), we
 * inject a repair advisory that tells the agent to:
 *   1. undo the last write to get back to a known-good state
 *   2. read_file to refresh its view of the file
 *   3. switch to apply_patch or write_file for the remaining changes
 *
 * The failure counter is session-scoped and reset on success for that file.
 */

export interface EditFailureRecoveryHookDeps {
  advisoryBus: Pick<AdvisoryBus, 'submit'>
}

const EDIT_TOOLS = new Set(['edit_file', 'hash_edit', 'write_file', 'ast_edit'])

export function createEditFailureRecoveryHook(deps: EditFailureRecoveryHookDeps): PostToolRuntimeHook {
  const failCounts = new Map<string, number>()

  return {
    phase: 'postTool',
    name: 'edit-failure-recovery',
    run(_ctx: RuntimeHookContext, tool: RuntimeToolEvent): void {
      if (!EDIT_TOOLS.has(tool.name)) return

      const filePath = extractFilePath(tool)
      if (!filePath) return

      if (tool.success) {
        failCounts.delete(filePath)
        return
      }

      const count = (failCounts.get(filePath) ?? 0) + 1
      failCounts.set(filePath, count)

      if (count >= 2) {
        deps.advisoryBus.submit({
          key: `edit-failure-recovery:${filePath}`,
          priority: 0.62,
          category: 'repair',
          tier: 'operational',
          content: `已连续 ${count} 次编辑 ${filePath} 失败。自动恢复建议：1) 调用 undo 撤销最近一次写入；2) 用 read_file 重新读取当前内容；3) 改用 apply_patch（统一 diff）或 write_file（全量覆写）完成修改，避免继续用 edit_file/hash_edit 原地修补。`,
          ttl: 1,
          expect: {
            kind: 'tool_appears',
            tools: ['undo', 'read_file', 'apply_patch', 'write_file'],
            targetIncludes: filePath,
            withinTurns: 2,
          },
        })
      }
    },
  }
}

function extractFilePath(tool: RuntimeToolEvent): string | undefined {
  if (typeof tool.input?.file_path === 'string') return tool.input.file_path
  if (typeof tool.input?.path === 'string') return tool.input.path
  return tool.target
}
