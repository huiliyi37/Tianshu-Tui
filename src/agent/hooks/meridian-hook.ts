import type { PostToolRuntimeHook } from '../runtime-hooks.js'
import type { MeridianIndexer } from '../../repo/meridian-indexer.js'

export interface MeridianHookDeps {
  getIndexer: () => MeridianIndexer | null
}

export function createMeridianHook(deps: MeridianHookDeps): PostToolRuntimeHook {
  return {
    phase: 'postTool',
    name: 'meridian-index',
    async run(ctx, tool) {
      const indexer = deps.getIndexer()
      if (!indexer) return

      if (tool.name === 'read_file' && tool.target && tool.success) {
        await indexer.indexFile(tool.target)
      }

      if ((tool.name === 'write_file' || tool.name === 'edit_file') && tool.target && tool.success) {
        await indexer.invalidateFile(tool.target)
        indexer.recordEdit(tool.target, ctx.snapshot.turn)
      }
    },
  }
}
