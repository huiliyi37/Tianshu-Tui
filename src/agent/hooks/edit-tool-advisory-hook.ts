import type { PostToolRuntimeHook, RuntimeHookContext, RuntimeToolEvent } from '../runtime-hooks.js'
import type { AdvisoryBus } from '../advisory-bus.js'

/**
 * Edit-Tool Advisory Hook — postTool detection of consecutive hash_edit calls
 * on the same file within a turn.
 *
 * When the agent uses hash_edit ≥2 times on the same file_path in a single
 * turn, the second call's anchors are stale (the first edit shifted line
 * numbers). This is the #1 cause of bracket-mismatch debris (see 53e1e4a8).
 *
 * Uses a turn-scoped Map instead of recentToolHistory (which only keeps 5
 * entries and would miss early hash_edit calls in heavy turns).
 *
 * Tier coordination: key='edit-tool-advisory', category='discipline',
 * priority=0.5. Deliberately lower than self-verify (0.58) and
 * discipline-reanchor (0.55) so it yields first under MAX_PER_CATEGORY=2.
 */

export interface EditToolAdvisoryHookDeps {
  advisoryBus: Pick<AdvisoryBus, 'submit'>
}

/** Turn-scoped state: file → hash_edit count this turn. Reset on new turn. */
interface TurnEditTracker {
  turn: number
  hashEditByFile: Map<string, number>
}

export function createEditToolAdvisoryHook(deps: EditToolAdvisoryHookDeps): PostToolRuntimeHook {
  const tracker: TurnEditTracker = { turn: -1, hashEditByFile: new Map() }

  return {
    phase: 'postTool',
    name: 'edit-tool-advisory',
    run(ctx: RuntimeHookContext, tool: RuntimeToolEvent): void {
      // Reset tracker on turn change
      if (ctx.snapshot.turn !== tracker.turn) {
        tracker.turn = ctx.snapshot.turn
        tracker.hashEditByFile.clear()
      }

      if (tool.name !== 'hash_edit') return

      // Extract file_path from the tool input
      const filePath = typeof tool.input?.file_path === 'string'
        ? tool.input.file_path
        : tool.target
      if (!filePath) return

      const count = (tracker.hashEditByFile.get(filePath) ?? 0) + 1
      tracker.hashEditByFile.set(filePath, count)

      if (count >= 2) {
        deps.advisoryBus.submit({
          key: 'edit-tool-advisory',
          priority: 0.5,
          category: 'discipline',
          content: `你已连续用 hash_edit 编辑同一文件 ${count} 次。每次编辑使后续锚点 stale——大括号配对容易错乱。考虑用 edit_file（old_string 精确匹配，不依赖行号）或 write_file（全量覆写）完成剩余修改。`,
          ttl: 1,
        })
      }
    },
  }
}
