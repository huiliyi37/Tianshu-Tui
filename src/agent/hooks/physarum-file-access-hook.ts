import { statSync } from 'node:fs'
import { relative, resolve, sep } from 'node:path'
import type { PostToolRuntimeHook } from '../runtime-hooks.js'
import type { PhysarumEngine } from '../../repo/physarum-engine.js'
import { isIndexablePhysarumFile } from '../../repo/physarum-engine.js'
import { validatePathSafe } from '../../tools/path-validate.js'

export interface PhysarumFileAccessHookDeps {
  getPhysarum: () => PhysarumEngine | null
}

const FILE_ACCESS_TOOLS = new Set(['read_file', 'write_file', 'edit_file', 'hash_edit'])

export function canonicalizePhysarumFileTarget(cwd: string, target: string | undefined): string | null {
  if (!target) return null

  const validated = validatePathSafe(cwd, target)
  if (!validated.ok) return null

  try {
    if (!statSync(validated.path).isFile()) return null
  } catch {
    return null
  }

  const rel = relative(resolve(cwd), validated.path).split(sep).join('/')
  if (!rel || rel.startsWith('../') || rel === '..') return null
  if (!isIndexablePhysarumFile(rel)) return null
  return rel
}

export function createPhysarumFileAccessHook(deps: PhysarumFileAccessHookDeps): PostToolRuntimeHook {
  return {
    phase: 'postTool',
    name: 'physarum-file-access',
    run(ctx, tool) {
      if (!tool.success) return
      if (!FILE_ACCESS_TOOLS.has(tool.name)) return

      const filePath = canonicalizePhysarumFileTarget(ctx.snapshot.cwd, tool.target)
      if (!filePath) return

      deps.getPhysarum()?.recordFileAccess(filePath, ctx.snapshot.turn)
    },
  }
}
