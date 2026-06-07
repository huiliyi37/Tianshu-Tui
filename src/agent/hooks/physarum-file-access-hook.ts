import { statSync } from 'node:fs'
import { relative, resolve, sep } from 'node:path'
import type { PostToolRuntimeHook } from '../runtime-hooks.js'
import type { PhysarumEngine } from '../../repo/physarum-engine.js'
import { isIndexablePhysarumFile } from '../../repo/physarum-engine.js'
import { validatePathSafe } from '../../tools/path-validate.js'

export interface PhysarumFilePredictionBatch {
  sourceFile: string
  afterToolName: string
  predictions: Array<{ file: string; score: number }>
}

export interface PhysarumFileAccessHookDeps {
  getPhysarum: () => PhysarumEngine | null
  onPredictions?: (batch: PhysarumFilePredictionBatch) => void
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

function getStructuredFilePath(toolName: string, input: Record<string, unknown> | undefined): string | undefined {
  if (!FILE_ACCESS_TOOLS.has(toolName)) return undefined
  return typeof input?.file_path === 'string' ? input.file_path : undefined
}

export function createPhysarumFileAccessHook(deps: PhysarumFileAccessHookDeps): PostToolRuntimeHook {
  return {
    phase: 'postTool',
    name: 'physarum-file-access',
    run(ctx, tool) {
      if (!tool.success) return

      const structuredPath = getStructuredFilePath(tool.name, tool.input)
      const filePath = canonicalizePhysarumFileTarget(ctx.snapshot.cwd, structuredPath)
      if (!filePath) return

      const physarum = deps.getPhysarum()
      if (!physarum) return
      physarum.recordFileAccess(filePath, ctx.snapshot.turn)

      const predictions = physarum.predictNext(filePath, 3)
      if (predictions.length > 0) {
        deps.onPredictions?.({
          sourceFile: filePath,
          afterToolName: tool.name,
          predictions,
        })
      }
    },
  }
}
