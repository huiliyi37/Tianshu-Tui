import { spawnSync } from 'node:child_process'
import { writeFileSync, unlinkSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import type { Tool, ToolCallParams } from './types.js'

export interface ApplyPatchInput {
  diff: string
  checkOnly?: boolean
}

export interface ApplyPatchResult {
  ok: boolean
  error: string
}

export function applyPatch(cwd: string, input: ApplyPatchInput): ApplyPatchResult {
  const patchFile = join(tmpdir(), `rivet-patch-${process.pid}-${Date.now()}.patch`)
  try {
    writeFileSync(patchFile, input.diff)
    const args = ['apply', '--3way']
    if (input.checkOnly) args.push('--check')
    args.push(patchFile)

    const result = spawnSync('git', args, {
      cwd,
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'pipe'],
    })

    if (result.status === 0) return { ok: true, error: '' }
    const stderr = typeof result.stderr === 'string' ? result.stderr.trim() : ''
    const stdout = typeof result.stdout === 'string' ? result.stdout.trim() : ''
    return { ok: false, error: stderr || stdout || `git apply exited with status ${result.status}` }
  } finally {
    try {
      unlinkSync(patchFile)
    } catch {
      // Best effort cleanup.
    }
  }
}

export const APPLY_PATCH_TOOL: Tool = {
  definition: {
    name: 'apply_patch',
    description: 'Apply a unified diff to the current git repository using git apply. Supports check-only validation before applying.',
    input_schema: {
      type: 'object',
      properties: {
        diff: {
          type: 'string',
          description: 'Unified diff content to apply.',
        },
        check_only: {
          type: 'boolean',
          description: 'Validate that the patch applies cleanly without modifying files.',
        },
      },
      required: ['diff'],
    },
  },

  async execute(params: ToolCallParams) {
    const diff = params.input.diff
    if (typeof diff !== 'string' || diff.trim().length === 0) {
      return { content: 'apply_patch requires a non-empty "diff" string.', isError: true }
    }

    const result = applyPatch(params.cwd, {
      diff,
      checkOnly: params.input.check_only === true,
    })

    if (!result.ok) {
      return { content: `Patch failed: ${result.error}`, isError: true }
    }

    return {
      content: params.input.check_only === true
        ? 'Patch applies cleanly (check-only; no files modified).'
        : 'Patch applied successfully.',
    }
  },

  requiresApproval: () => true,
  isConcurrencySafe: () => false,
  isEnabled: () => true,
}
