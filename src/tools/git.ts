import { execFile } from 'node:child_process'
import { isAbsolute, relative, resolve } from 'node:path'
import { promisify } from 'node:util'
import type { Tool, ToolCallParams } from './types.js'
import { auditCommitTagScope } from './commit-audit.js'
import { createWorkspaceGuard } from '../agent/workspace-guard.js'

const execFileP = promisify(execFile)

const ACTIONS = ['status', 'diff_summary', 'commit', 'log', 'stash', 'stash_pop'] as const
type GitAction = (typeof ACTIONS)[number]

const MAX_OUTPUT = 50_000
const GIT_TIMEOUT = 10_000

async function runGit(args: string[], cwd: string): Promise<string> {
  const { stdout, stderr } = await execFileP('git', args, {
    cwd,
    encoding: 'utf-8',
    timeout: GIT_TIMEOUT,
  })
  const output = stdout as string
  if (output.length > MAX_OUTPUT) {
    return output.slice(0, MAX_OUTPUT) + `\n\n[... truncated at ${MAX_OUTPUT} chars, total ${output.length}]`
  }
  return output
}

/** runGit that returns {ok, output} instead of throwing — for callers that need error detail. */
async function runGitSafe(args: string[], cwd: string): Promise<{ ok: boolean; output: string }> {
  try {
    const output = await runGit(args, cwd)
    return { ok: true, output }
  } catch (err) {
    const output = err instanceof Error ? err.message : String(err)
    return { ok: false, output }
  }
}

function normalizeProjectRelativePath(cwd: string, filePath: string): string | null {
  const resolved = resolve(cwd, filePath)
  const rel = relative(cwd, resolved)
  if (rel === '' || rel.startsWith('..') || isAbsolute(rel)) return null
  return rel
}

function getScopedCommitFiles(cwd: string, ownedFiles: string[] | undefined, sessionModifiedFiles: string[] | undefined): string[] {
  // B1: prefer ownedFiles (post-baseline) over sessionModifiedFiles (pre-baseline)
  const source = (ownedFiles?.length ? ownedFiles : sessionModifiedFiles) ?? []
  if (!source.length) return []
  const files = source
    .map(filePath => normalizeProjectRelativePath(cwd, filePath))
    .filter((filePath): filePath is string => filePath !== null)
  return [...new Set(files)].sort((a, b) => a.localeCompare(b))
}

async function hasStagedChanges(cwd: string, pathspecs?: string[]): Promise<boolean> {
  const args = ['diff', '--cached', '--quiet']
  if (pathspecs?.length) args.push('--', ...pathspecs)
  try {
    await execFileP('git', args, { cwd, encoding: 'utf-8', timeout: GIT_TIMEOUT })
    return false // exit 0 = no staged changes
  } catch (err: unknown) {
    const code = (err as { code?: number }).code
    if (code === 1) return true // exit 1 = has staged changes
    throw err
  }
}

/** Best-effort: create a safety ref before stash so changes are recoverable (P2). */
async function createSafetyRef(cwd: string): Promise<void> {
  try {
    const { stdout } = await execFileP('git', ['stash', 'create'], { cwd, encoding: 'utf-8', timeout: GIT_TIMEOUT })
    const sha = (stdout as string).trim()
    if (!sha) return
    await execFileP('git', ['update-ref', 'refs/kiro-safety/last-stash', sha], { cwd, encoding: 'utf-8', timeout: GIT_TIMEOUT })
  } catch { /* best-effort, never block stash */ }
}

export const GIT_TOOL: Tool = {
  definition: {
    name: 'git',
    description: `Structured git operations. Actions:
- status: Show working tree status, current branch, and file changes
- diff_summary: Show diff stats for staged and unstaged changes
- commit: Commit only this session's modified files when available; otherwise commit already staged changes only
- log: Show recent commit history (default 20, configurable with maxCount)
- stash: Stash current working directory changes

For complex git operations (branch, merge, rebase, push, pull), use the bash tool instead.`,
    input_schema: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: [...ACTIONS],
          description: 'The git operation to perform',
        },
        message: {
          type: 'string',
          description: 'Commit message (required for commit action)',
        },
        maxCount: {
          type: 'number',
          description: 'Maximum number of log entries (default 20, for log action)',
        },
      },
      required: ['action'],
    },
  },

  async execute(params: ToolCallParams) {
    const action = params.input.action as GitAction
    const cwd = params.cwd

    if (!ACTIONS.includes(action)) {
      return { content: `Unknown action: ${action}. Supported: ${ACTIONS.join(', ')}`, isError: true }
    }

    try {
      switch (action) {
        case 'status': {
          const [branch, porcelain, untracked] = await Promise.all([
            runGit(['branch', '--show-current'], cwd),
            runGit(['status', '--porcelain'], cwd),
            runGit(['ls-files', '--others', '--exclude-standard'], cwd),
          ])
          const lines = [`Branch: ${branch.trim()}`]
          const porcelainTrimmed = porcelain.trim()
          if (!porcelainTrimmed) {
            lines.push('Status: clean')
          } else {
            lines.push('Changes:', porcelainTrimmed)
          }
          const untrackedTrimmed = untracked.trim()
          if (untrackedTrimmed) {
            lines.push('Untracked:', untrackedTrimmed)
          }
          return { content: lines.join('\n') }
        }

        case 'diff_summary': {
          const [staged, unstaged] = await Promise.all([
            runGit(['diff', '--cached', '--stat'], cwd),
            runGit(['diff', '--stat'], cwd),
          ])
          const lines: string[] = []
          const stagedTrimmed = staged.trim()
          const unstagedTrimmed = unstaged.trim()
          if (stagedTrimmed) lines.push('Staged:', stagedTrimmed)
          if (unstagedTrimmed) lines.push('Unstaged:', unstagedTrimmed)
          if (!stagedTrimmed && !unstagedTrimmed) lines.push('No changes.')
          return { content: lines.join('\n') }
        }

        case 'commit': {
          const message = params.input.message as string
          if (!message) {
            return { content: 'Commit requires a "message" parameter.', isError: true }
          }

          const scopedFiles = getScopedCommitFiles(cwd, params.ownedFiles, params.sessionModifiedFiles)
          const commitArgs = ['commit', '-m', message]
          if (scopedFiles.length > 0) {
            await runGit(['add', '--', ...scopedFiles], cwd)
            commitArgs.push('--only', '--', ...scopedFiles)
          } else if (!(await hasStagedChanges(cwd))) {
            return {
              content: 'No session-owned files were provided to git commit and no staged changes exist. Use deliver_task with commit=true for ownership-scoped delivery, or stage explicit files if you intentionally manage git manually.',
              isError: true,
            }
          }

          const commitResult = await runGitSafe(commitArgs, cwd)
          if (!commitResult.ok) {
            return { content: `git commit failed: ${commitResult.output}`, isError: true }
          }

          // Post-commit truth readback: show actual landed changes + audit tag scope
          const changed = (await runGit(['show', '--stat', '--format=%h%d', 'HEAD'], cwd)).trim()
          // --stat file rows contain '|'; this excludes the %h%d header line and the summary line
          const changedFiles = changed.split('\n')
            .filter(l => l.includes('|'))
            .map(l => l.split('|')[0]!.trim())
            .filter(f => f.length > 0)
          const audit = auditCommitTagScope(message, changedFiles)
          const body = `${commitResult.output.trim()}\n\n--- actual changes (git show --stat) ---\n${changed}`
          return { content: audit.ok ? body : `${body}\n\n${audit.message}` }
        }

        case 'log': {
          const maxCount = Math.max(1, Math.min((params.input.maxCount as number) ?? 20, 100))
          const log = (await runGit(['log', `--max-count=${maxCount}`, '--oneline', '--decorate'], cwd)).trim()
          return { content: log || 'No commits yet.' }
        }

        case 'stash': {
          const stashStatus = (await runGit(['status', '--porcelain'], cwd)).trim()
          if (!stashStatus) {
            return { content: 'No changes to stash.' }
          }

          // B1: scope stash to owned files when available
          if (params.ownedFiles?.length) {
            const scoped = getScopedCommitFiles(cwd, params.ownedFiles, params.sessionModifiedFiles)
            if (scoped.length === 0) {
              return {
                content: 'No owned files to stash. External dirty files are present but excluded from stash scope.',
                isError: true,
              }
            }
            await createSafetyRef(cwd)
            await runGit(['stash', 'push', '--', ...scoped], cwd)
            return { content: `Stashed ${scoped.length} owned file(s): ${scoped.join(', ')}` }
          }

          await createSafetyRef(cwd)
          await runGit(['stash'], cwd)
          return { content: 'Saved working directory and index state.' }
        }

        case 'stash_pop': {
          const stashRef = (params.input.stashRef as string) || 'stash@{0}'
          const safety = await createWorkspaceGuard(cwd).checkStashSafety(stashRef)
          if (safety.blocked) {
            return { content: safety.reasons.join('\n'), isError: true }
          }
          await runGit(['stash', 'pop', stashRef], cwd)
          return { content: `Popped ${stashRef} (safety-checked: no overwriting conflicts).` }
        }

        default:
          return { content: `Unknown action: ${action}. Supported: ${ACTIONS.join(', ')}`, isError: true }
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      return { content: `git ${action} failed: ${message}`, isError: true }
    }
  },

  requiresApproval(params: ToolCallParams): boolean {
    return (params.input.action as string) === 'commit'
  },

  isConcurrencySafe: () => false,
  isEnabled: () => true,
}
