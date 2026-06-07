import { spawn } from 'node:child_process'
import { writeFile, unlink } from 'node:fs/promises'
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

export async function applyPatch(cwd: string, input: ApplyPatchInput, abortSignal?: AbortSignal): Promise<ApplyPatchResult> {
  const patchFile = join(tmpdir(), `rivet-patch-${process.pid}-${Date.now()}.patch`)
  try {
    await writeFile(patchFile, input.diff)
    const args = ['apply', '--3way']
    if (input.checkOnly) args.push('--check')
    args.push(patchFile)

    const result = await new Promise<{status: number | null, stderr: string, stdout: string}>((resolve, reject) => {
      const child = spawn('git', args, {
        cwd,
        stdio: ['ignore', 'pipe', 'pipe'],
      })
      let stdout = ''
      let stderr = ''
      child.stdout?.on('data', (d: Buffer) => { stdout += d.toString() })
      child.stderr?.on('data', (d: Buffer) => { stderr += d.toString() })
      child.on('close', (status) => resolve({ status, stderr, stdout }))
      child.on('error', reject)

      if (abortSignal) {
        const onAbort = () => { child.kill('SIGTERM') }
        if (abortSignal.aborted) {
          child.kill('SIGTERM')
        } else {
          abortSignal.addEventListener('abort', onAbort, { once: true })
          child.on('close', () => { abortSignal.removeEventListener('abort', onAbort) })
        }
      }
    })

    if (result.status === 0) return { ok: true, error: '' }
    const errTrimmed = result.stderr.trim()
    const outTrimmed = result.stdout.trim()
    return { ok: false, error: errTrimmed || outTrimmed || `git apply exited with status ${result.status}` }
  } finally {
    try {
      await unlink(patchFile)
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

    const result = await applyPatch(params.cwd, {
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
