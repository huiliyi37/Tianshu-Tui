import type { PostToolRuntimeHook } from '../runtime-hooks.js'

export interface ConsistencyCheckHookDeps {
  /**
   * 返回当前活跃的 file_observation claims。
   * 由 anchor-registry 或 claim-store 提供。
   */
  getFileObservations: () => Array<{ id: string; text: string; evidence: Array<{ path?: string }> }>
}

/**
 * 原则 ⑤ 有限规则无限涌现
 *
 * 当 write_file / edit_file 写入一个文件时，检查是否有 file_observation claim
 * 引用了该文件的旧状态。如果有，调用 markClaimStale 将其标记为过期。
 *
 * 这是 cross-store 耦合的第一条信号：evidence store（工具结果）→ claim store（知识）。
 */
export function createConsistencyCheckHook(deps: ConsistencyCheckHookDeps): PostToolRuntimeHook {
  return {
    phase: 'postTool',
    name: 'consistency-check',
    run(ctx, tool) {
      // 只在写操作后触发
      if (tool.name !== 'write_file' && tool.name !== 'edit_file') return
      if (!tool.target) return

      const observations = deps.getFileObservations()
      for (const obs of observations) {
        const referencesFile = obs.evidence.some(
          e => e.path && (e.path === tool.target || tool.target!.endsWith(e.path) || e.path.endsWith(tool.target!)),
        )
        if (referencesFile) {
          ctx.effects.markClaimStale(obs.id)
        }
      }
    },
  }
}
