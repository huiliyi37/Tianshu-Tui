import { spawnGit } from './spawn-git.js'
import { writeFile, unlink, readFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import type { Tool, ToolCallParams } from './types.js'
import { checkSyntax } from './syntax-check.js'
import { trackFileChange, restoreLatestBackup } from '../agent/recovery-stack.js'
import { incrementEditFailCount, resetEditFailCount, recordSuccessfulEdit } from './read-file.js'
import { APPLY_PATCH_POINTER_PREFIX } from './apply-patch-arg-processor.js'

/** Post-apply syntax verification + rollback. Default on; RIVET_APPLY_PATCH_VERIFY=0
 *  falls back to the legacy "git apply and trust it" behaviour. */
function isApplyPatchVerifyEnabled(): boolean {
  const v = process.env.RIVET_APPLY_PATCH_VERIFY
  return v !== '0' && v !== 'false'
}

interface PatchTarget {
  /** Repo-relative path (forward slashes). */
  rel: string
  /** Absolute path on disk. */
  abs: string
  /** Whether the file existed before the patch (governs rollback strategy). */
  existedBefore: boolean
}

/** Extract the set of files a unified diff writes to (its `+++ ` headers).
 *  Skips `/dev/null` (pure deletions) — those carry no post-apply content to
 *  verify. Mirrors the arg-processor's parser so target sets stay consistent. */
export function extractPatchTargetPaths(diff: string): string[] {
  const paths = new Set<string>()
  for (const line of diff.split('\n')) {
    if (!line.startsWith('+++ ')) continue
    let p = line.slice(4).trim()
    const tabIdx = p.indexOf('\t')
    if (tabIdx !== -1) p = p.slice(0, tabIdx)
    if (p === '/dev/null') continue
    p = p.replace(/^"(.*)"$/, '$1')
    p = p.replace(/^[ab]\//, '')
    if (p.length > 0) paths.add(p)
  }
  return [...paths]
}

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
      const child = spawnGit(args, {
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
    description: 'Apply a unified diff to the current git repository using git apply. Supports check-only validation before applying. Use for multi-file changes or applying an existing patch; for a single targeted edit prefer edit_file or hash_edit. Note: after a large patch is applied, the message history keeps only a summary pointer (changed file list + size) instead of the verbatim diff — use read_file or git diff to inspect the result. check_only validations keep the full diff inline.',
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

    // Pointer-regurgitation guard: the arg processor collapses large diffs in
    // message history to "[patch applied to …]". The model sometimes echoes
    // that pointer back as the diff — applying it is meaningless and confusing.
    if (diff.trimStart().startsWith(APPLY_PATCH_POINTER_PREFIX)) {
      return {
        content: `Error: the "diff" is a collapsed history pointer ("${APPLY_PATCH_POINTER_PREFIX} …"), not a real unified diff. `
          + 'That placeholder only appears in past messages after a large patch was applied — it is never valid input. '
          + 'Provide the actual unified diff, or use read_file / git diff to inspect the current state first.',
        isError: true,
      }
    }

    // Normalize header paths to forward slashes so patches produced on/with
    // Windows paths still apply cleanly and render as valid unified diffs.
    const normalizedDiff = normalizeDiffPaths(diff)
    const checkOnly = params.input.check_only === true
    const verify = isApplyPatchVerifyEnabled() && !checkOnly

    // Snapshot targets + back them up BEFORE applying, so a corrupting patch
    // can be rolled back per-file. check_only never writes, so it skips this.
    const targets: PatchTarget[] = verify
      ? extractPatchTargetPaths(normalizedDiff).map((rel) => {
          const abs = join(params.cwd, rel)
          return { rel, abs, existedBefore: existsSync(abs) }
        })
      : []
    for (const t of targets) {
      if (t.existedBefore) {
        trackFileChange(params.cwd, { filePath: t.rel, action: 'edit', toolCallId: params.toolUseId ?? 'apply_patch' })
      }
    }

    const result = await applyPatch(params.cwd, {
      diff: normalizedDiff,
      checkOnly,
    })

    if (!result.ok) {
      for (const t of targets) incrementEditFailCount(t.abs)
      return { content: `Patch failed: ${result.error}`, isError: true }
    }

    // Post-apply structural verification: git apply --3way can leave conflict
    // markers or the patch itself can introduce a syntax error, either of which
    // silently corrupts the file. Parse-check each written file; on a fatal
    // error roll the whole patch back (restore backups / delete new files).
    if (verify) {
      const fatal = await firstFatalSyntax(targets)
      if (fatal) {
        await rollbackTargets(params.cwd, targets)
        for (const t of targets) incrementEditFailCount(t.abs)
        return {
          content: `Patch applied but introduced a fatal error in ${fatal.rel}:\n${fatal.message}\n\n`
            + 'The patch has been automatically rolled back. Fix the diff (check for context drift / conflict markers) and retry.',
          isError: true,
        }
      }
      for (const t of targets) {
        resetEditFailCount(t.abs)
        await recordSuccessfulEdit(t.abs, params.sessionId)
      }
    }

    // uiContent (display-only): echo the applied diff so the TUI/desktop card
    // renders a colored +/- inline diff. Model-facing `content` stays a short
    // summary (unchanged) → no prefix-cache/context cost. Cap the display diff
    // to keep the UI responsive for huge patches.
    return {
      content: checkOnly
        ? 'Patch applies cleanly (check-only; no files modified).'
        : 'Patch applied successfully.',
      uiContent: truncateDiffForUi(normalizedDiff.trim()),
    }
  },

  requiresApproval: () => true,
  isConcurrencySafe: () => false,
  isEnabled: () => true,
}

/** Parse-check each written target; return the first fatal error found, or null.
 *  A read/check failure for one file degrades to "skip" (never blocks a patch
 *  whose file we simply can't re-read). */
async function firstFatalSyntax(targets: PatchTarget[]): Promise<{ rel: string; message: string } | null> {
  for (const t of targets) {
    if (!existsSync(t.abs)) continue
    try {
      const content = await readFile(t.abs, 'utf-8')
      const check = await checkSyntax(t.abs, content)
      if (check.fatal) return { rel: t.rel, message: check.fatal }
    } catch {
      // Unreadable (binary, races) — not a syntax verdict, skip.
    }
  }
  return null
}

/** Undo an applied patch: restore pre-patch content for files that existed,
 *  delete files the patch newly created. Best-effort per file. */
async function rollbackTargets(cwd: string, targets: PatchTarget[]): Promise<void> {
  for (const t of targets) {
    if (t.existedBefore) {
      restoreLatestBackup(cwd, t.rel)
    } else {
      try { await unlink(t.abs) } catch { /* already gone */ }
    }
  }
}

const APPLY_PATCH_MAX_UI_LINES = 600

/** Normalize backslashes to forward slashes only in diff header lines so a
 *  patch created on Windows (or mentioning Windows paths) stays valid for
 *  `git apply` and renders correctly as a unified diff. Context/code lines are
 *  left untouched. */
function normalizeDiffPaths(diff: string): string {
  return diff
    .split('\n')
    .map((line) => {
      if (
        line.startsWith('--- ') ||
        line.startsWith('+++ ') ||
        line.startsWith('diff --git')
      ) {
        return line.replace(/\\/g, '/')
      }
      return line
    })
    .join('\n')
}

/** Cap display-only diff lines; excess is replaced by a single hint line. */
function truncateDiffForUi(diff: string, maxLines = APPLY_PATCH_MAX_UI_LINES): string {
  const lines = diff.split('\n')
  if (lines.length <= maxLines) return diff
  const hidden = lines.length - maxLines
  return [...lines.slice(0, maxLines), `… (${hidden} more diff lines, Ctrl+O)`].join('\n')
}
